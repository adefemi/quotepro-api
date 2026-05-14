import { randomBytes, randomInt } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { GoogleProfile } from "./auth/google.js";
import {
  type WhatsAppOtpSender,
  WhatsAppConfigError,
  WhatsAppDeliveryError,
} from "./notifications/whatsapp.js";

import type {
  CompanyProfileDto,
  NotificationPushKind,
  NotificationPushPayload,
  PaymentRecordDto,
  PaymentPurpose,
  PaymentStatus,
  PayoutAccountDto,
  ProviderNotificationDto,
  QuoteClientFeedbackDto,
  ProviderProfileDto,
  QuoteBundleDto,
  QuoteDto,
  QuoteEventDto,
  QuoteLineItemDto,
  QuotePublicActionResult,
  QuoteStatus,
} from "./domain.js";
import type { Database, DatabaseClient } from "./db/pool.js";
import { withTransaction } from "./db/pool.js";
import { generateQuoteFromPrompt, type GeneratedQuote } from "./quotes/quote-engine.js";

function token() {
  return randomBytes(32).toString("hex");
}

function quoteNumber() {
  return `Q-${randomBytes(2).toString("hex").toUpperCase()}`;
}

function publicSlug() {
  return `${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

function formatDate(value: string | Date) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return value;
}

function quoteFromProvidedItems(input: {
  prompt: string;
  collectDeposit: boolean;
  jobTitle?: string;
  description?: string;
  items?: Array<{
    title: string;
    quantityLabel: string;
    unitAmount: number;
    totalAmount: number;
  }>;
}): GeneratedQuote | null {
  if (!input.items) {
    return null;
  }

  const items = input.items.map((item, index) => ({
    id: `item-${String(index + 1).padStart(2, "0")}`,
    title: item.title,
    quantityLabel: item.quantityLabel,
    unitAmount: item.unitAmount,
    totalAmount: item.totalAmount,
  }));
  const subtotalAmount = items.reduce((sum, item) => sum + item.totalAmount, 0);
  const vatAmount = Math.round(subtotalAmount * 0.075);
  const totalAmount = subtotalAmount + vatAmount;

  return {
    jobTitle: input.jobTitle ?? "Custom service job",
    description: input.description ?? input.prompt,
    items,
    subtotalAmount,
    vatAmount,
    totalAmount,
    depositAmount: input.collectDeposit ? Math.round(totalAmount * 0.5) : 0,
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
}

function mapProvider(row: QueryResultRow): ProviderProfileDto {
  return {
    id: row.id,
    businessName: row.business_name,
    serviceLine: row.service_line,
    customerPhone: row.customer_phone,
    accountPhone: row.account_phone ?? undefined,
    googleEmail: row.google_email ?? undefined,
    googlePictureUrl: row.google_picture_url ?? undefined,
    hasAccount: Boolean(row.phone_verified_at) || Boolean(row.google_sub),
    hasPin: Boolean(row.pin_set_at),
    hasLogo: row.has_logo,
    hasPayoutAccount: Boolean(row.payout_bank_name),
    payoutBankName: row.payout_bank_name ?? undefined,
    payoutAccountLast4: row.account_number_last4 ?? undefined,
  };
}

function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function mapCompany(row: QueryResultRow): CompanyProfileDto {
  return {
    id: row.id,
    providerId: row.provider_id,
    businessName: row.business_name,
    serviceLine: row.service_line,
    customerPhone: row.customer_phone,
    logoUrl: row.logo_url ?? undefined,
    isDefault: row.is_default,
  };
}

function mapPayoutAccount(row: QueryResultRow): PayoutAccountDto {
  return {
    id: row.id,
    providerId: row.provider_id,
    bankName: row.bank_name,
    bankCode: row.bank_code ?? undefined,
    accountLast4: row.account_number_last4,
    accountName: row.account_name ?? undefined,
    isDefault: row.is_default,
  };
}

function mapQuote(row: QueryResultRow, items: QuoteLineItemDto[], company?: CompanyProfileDto): QuoteDto {
  return {
    id: row.quote_number,
    publicSlug: row.public_slug,
    providerId: row.provider_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerLocation: row.customer_location,
    jobTitle: row.job_title,
    description: row.description,
    subtotalAmount: row.subtotal_amount,
    vatAmount: row.vat_amount,
    totalAmount: row.total_amount,
    depositAmount: row.deposit_amount,
    validUntil: formatDate(row.valid_until),
    status: row.status,
    collectDeposit: row.collect_deposit,
    company,
    items,
  };
}

function mapEvent(row: QueryResultRow): QuoteEventDto {
  return {
    id: row.id,
    quoteId: row.quote_number,
    kind: row.kind,
    label: row.label,
    at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
  };
}

function mapQuoteFeedback(row: QueryResultRow): QuoteClientFeedbackDto {
  return {
    id: row.id as string,
    quoteId: row.quote_number as string,
    type: row.type as "revision_request" | "review",
    message: row.message as string,
    rating: row.rating ?? undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

async function getQuoteItems(db: DatabaseClient, quoteUuid: string): Promise<QuoteLineItemDto[]> {
  const result = await db.query(
    `
      select id::text, title, quantity_label, unit_amount, total_amount
      from quote_items
      where quote_id = $1
      order by sort_order asc, id asc
    `,
    [quoteUuid],
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    quantityLabel: row.quantity_label,
    unitAmount: row.unit_amount,
    totalAmount: row.total_amount,
  }));
}

async function getQuoteEvents(db: DatabaseClient, quoteUuid: string): Promise<QuoteEventDto[]> {
  const result = await db.query(
    `
      select qe.id::text, q.quote_number, qe.kind, qe.label, qe.occurred_at
      from quote_events qe
      join quotes q on q.id = qe.quote_id
      where qe.quote_id = $1
      order by qe.occurred_at asc
    `,
    [quoteUuid],
  );

  return result.rows.map(mapEvent);
}

async function getQuoteFeedback(db: DatabaseClient, quoteUuid: string): Promise<QuoteClientFeedbackDto[]> {
  const result = await db.query(
    `
      select qcf.id::text, q.quote_number, qcf.type, qcf.message, qcf.rating, qcf.created_at
      from quote_client_feedback qcf
      join quotes q on q.id = qcf.quote_id
      where qcf.quote_id = $1
      order by qcf.created_at asc
    `,
    [quoteUuid],
  );

  return result.rows.map(mapQuoteFeedback);
}

async function getQuoteCompany(db: DatabaseClient, companyId?: string | null): Promise<CompanyProfileDto | undefined> {
  if (!companyId) {
    return undefined;
  }

  const company = await getCompanyById(db, companyId);
  return company ?? undefined;
}

async function findQuoteRow(db: DatabaseClient, slugOrId: string) {
  const result = await db.query(
    `
      select *
      from quotes
      where lower(public_slug) = lower($1) or lower(quote_number) = lower($1) or id::text = $1
      limit 1
    `,
    [slugOrId],
  );

  return result.rows[0];
}

async function insertQuoteProviderNotification(
  client: DatabaseClient,
  input: {
    providerId: string;
    quoteId: string;
    kind: NotificationPushKind;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const result = await client.query(
    `
      insert into provider_notifications (provider_id, quote_id, kind, title, body, metadata)
      values ($1, $2, $3, $4, $5, $6::jsonb)
      returning id::text
    `,
    [
      input.providerId,
      input.quoteId,
      input.kind,
      input.title,
      input.body,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  return result.rows[0].id as string;
}

export async function upsertPushDevice(
  db: Database,
  providerId: string,
  input: { token: string; platform: "ios" | "android"; appVersion?: string; deviceId?: string },
) {
  await db.query(
    `
      insert into provider_push_devices (provider_id, fcm_token, platform, app_version, device_id, last_seen_at)
      values ($1, $2, $3, $4, $5, now())
      on conflict (provider_id, fcm_token)
      do update set
        platform = excluded.platform,
        app_version = excluded.app_version,
        device_id = excluded.device_id,
        last_seen_at = now()
    `,
    [providerId, input.token, input.platform, input.appVersion ?? null, input.deviceId ?? null],
  );
}

export async function deletePushDevice(db: Database, providerId: string, token: string) {
  await db.query(`delete from provider_push_devices where provider_id = $1 and fcm_token = $2`, [
    providerId,
    token,
  ]);
}

export async function listFcmTokensForProvider(db: Database, providerId: string): Promise<string[]> {
  const result = await db.query(
    `select fcm_token from provider_push_devices where provider_id = $1`,
    [providerId],
  );

  return result.rows.map((row) => row.fcm_token as string);
}

function mapProviderNotification(row: QueryResultRow): ProviderNotificationDto {
  return {
    id: row.id as string,
    quoteId: row.quote_id ? (row.quote_id as string) : null,
    kind: row.kind as string,
    title: row.title as string,
    body: row.body as string,
    readAt: row.read_at ? (row.read_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function listProviderNotifications(
  db: Database,
  providerId: string,
  options: { limit: number },
): Promise<ProviderNotificationDto[]> {
  const result = await db.query(
    `
      select id::text, quote_id::text, kind, title, body, read_at, created_at
      from provider_notifications
      where provider_id = $1
      order by created_at desc
      limit $2
    `,
    [providerId, options.limit],
  );

  return result.rows.map(mapProviderNotification);
}

export async function markProviderNotificationRead(db: Database, providerId: string, notificationId: string) {
  const result = await db.query(
    `
      update provider_notifications
      set read_at = coalesce(read_at, now())
      where id = $1 and provider_id = $2
      returning id::text
    `,
    [notificationId, providerId],
  );

  return Boolean(result.rows[0]);
}

export async function deleteProviderNotification(db: Database, providerId: string, notificationId: string) {
  const result = await db.query(
    `
      delete from provider_notifications
      where id = $1 and provider_id = $2 and read_at is not null
      returning id::text
    `,
    [notificationId, providerId],
  );

  return Boolean(result.rows[0]);
}

export async function listCompanies(db: Database, providerId: string): Promise<CompanyProfileDto[]> {
  const result = await db.query(
    `
      select id::text, provider_id::text, business_name, service_line, customer_phone, logo_url, is_default
      from provider_companies
      where provider_id = $1
      order by is_default desc, created_at asc
    `,
    [providerId],
  );

  return result.rows.map(mapCompany);
}

export async function getCompanyById(db: DatabaseClient, companyId: string): Promise<CompanyProfileDto | null> {
  const result = await db.query(
    `
      select id::text, provider_id::text, business_name, service_line, customer_phone, logo_url, is_default
      from provider_companies
      where id = $1
      limit 1
    `,
    [companyId],
  );

  return result.rows[0] ? mapCompany(result.rows[0]) : null;
}

export async function getDefaultCompany(db: DatabaseClient, providerId: string): Promise<CompanyProfileDto | null> {
  const result = await db.query(
    `
      select id::text, provider_id::text, business_name, service_line, customer_phone, logo_url, is_default
      from provider_companies
      where provider_id = $1
      order by is_default desc, created_at asc
      limit 1
    `,
    [providerId],
  );

  return result.rows[0] ? mapCompany(result.rows[0]) : null;
}

export async function createCompany(
  db: Database,
  providerId: string,
  input: { businessName: string; serviceLine: string; customerPhone?: string; logoUrl?: string },
) {
  return withTransaction(db, async (client) => {
    const existing = await client.query("select 1 from provider_companies where provider_id = $1 limit 1", [providerId]);
    const isDefault = existing.rows.length === 0;
    const result = await client.query(
      `
        insert into provider_companies (
          provider_id, business_name, service_line, customer_phone, logo_url, is_default
        )
        values ($1, $2, $3, $4, $5, $6)
        returning id::text, provider_id::text, business_name, service_line, customer_phone, logo_url, is_default
      `,
      [providerId, input.businessName, input.serviceLine, input.customerPhone ?? "", input.logoUrl ?? null, isDefault],
    );

    return mapCompany(result.rows[0]);
  });
}

export async function updateCompany(
  db: Database,
  providerId: string,
  companyId: string,
  input: { businessName: string; serviceLine: string; customerPhone?: string; logoUrl?: string },
) {
  const result = await db.query(
    `
      update provider_companies
      set business_name = $3,
        service_line = $4,
        customer_phone = $5,
        logo_url = coalesce($6, logo_url)
      where id = $1 and provider_id = $2
      returning id::text, provider_id::text, business_name, service_line, customer_phone, logo_url, is_default
    `,
    [companyId, providerId, input.businessName, input.serviceLine, input.customerPhone ?? "", input.logoUrl ?? null],
  );

  return result.rows[0] ? mapCompany(result.rows[0]) : null;
}

export async function updateCompanyLogo(db: Database, providerId: string, companyId: string, logoUrl: string) {
  const result = await db.query(
    `
      update provider_companies
      set logo_url = $3
      where id = $1 and provider_id = $2
      returning id::text, provider_id::text, business_name, service_line, customer_phone, logo_url, is_default
    `,
    [companyId, providerId, logoUrl],
  );

  return result.rows[0] ? mapCompany(result.rows[0]) : null;
}

export async function ensureDefaultCompany(
  db: DatabaseClient,
  providerId: string,
  input?: { businessName?: string; serviceLine?: string; customerPhone?: string },
) {
  const existing = await getDefaultCompany(db, providerId);
  if (existing) {
    return existing;
  }

  const provider = await getProviderById(db, providerId);
  const result = await db.query(
    `
      insert into provider_companies (
        provider_id, business_name, service_line, customer_phone, is_default
      )
      values ($1, $2, $3, $4, true)
      returning id::text, provider_id::text, business_name, service_line, customer_phone, logo_url, is_default
    `,
    [
      providerId,
      input?.businessName || provider.businessName || "My Company",
      input?.serviceLine || provider.serviceLine || "General services",
      input?.customerPhone ?? provider.customerPhone ?? "",
    ],
  );

  return mapCompany(result.rows[0]);
}

export async function createSession(db: Database, input: { channel: string }) {
  return withTransaction(db, async (client) => {
    const provider = await client.query(
      "insert into providers default values returning id::text",
    );
    const sessionToken = token();

    await client.query(
      `
        insert into provider_sessions (provider_id, token, channel)
        values ($1, $2, $3)
      `,
      [provider.rows[0].id, sessionToken, input.channel],
    );

    return {
      token: sessionToken,
      provider: await getProviderById(client, provider.rows[0].id),
    };
  });
}

export interface StartPhoneOtpResult {
  phone: string;
  expiresAt: string;
  channel: "whatsapp";
  delivered: boolean;
  code?: string;
}

export class PhoneOtpDeliveryError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PhoneOtpDeliveryError";
    this.cause = cause;
  }
}

export async function startPhoneOtp(
  db: Database,
  input: { phone: string },
  options: { sender?: WhatsAppOtpSender; exposeCode?: boolean } = {},
): Promise<StartPhoneOtpResult> {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await db.query(
    `
      insert into phone_otps (phone, code, expires_at)
      values ($1, $2, $3)
      on conflict (phone) do update
      set code = excluded.code, expires_at = excluded.expires_at, created_at = now()
    `,
    [input.phone, code, expiresAt],
  );

  const sender = options.sender;
  let delivered = false;
  if (sender) {
    try {
      await sender({ phone: input.phone, code });
      delivered = true;
    } catch (error) {
      if (error instanceof WhatsAppConfigError) {
        if (!options.exposeCode) {
          throw new PhoneOtpDeliveryError(
            "WhatsApp delivery is not configured.",
            error,
          );
        }
      } else if (error instanceof WhatsAppDeliveryError) {
        throw new PhoneOtpDeliveryError(
          "Failed to deliver OTP via WhatsApp.",
          error,
        );
      } else {
        throw error;
      }
    }
  }

  const result: StartPhoneOtpResult = {
    phone: input.phone,
    expiresAt: expiresAt.toISOString(),
    channel: "whatsapp",
    delivered,
  };

  if (options.exposeCode) {
    result.code = code;
  }

  return result;
}

export async function verifyPhoneOtp(
  db: Database,
  input: { phone: string; code: string; existingProviderId?: string },
) {
  return withTransaction(db, async (client) => {
    const otp = await client.query(
      "select code, expires_at from phone_otps where phone = $1",
      [input.phone],
    );

    const row = otp.rows[0];
    if (!row || row.code !== input.code || new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }

    const existingByPhone = await client.query(
      "select id::text from providers where account_phone = $1 limit 1",
      [input.phone],
    );
    const phoneProviderId = existingByPhone.rows[0]?.id;
    const providerId = phoneProviderId ?? input.existingProviderId;
    const provider = providerId
      ? await client.query(
          `
            update providers
            set account_phone = $2,
              customer_phone = case when customer_phone = '' then $2 else customer_phone end,
              phone_verified_at = now()
            where id = $1
            returning id::text
          `,
          [providerId, input.phone],
        )
      : await client.query(
          `
            insert into providers (account_phone, customer_phone, phone_verified_at)
            values ($1, $1, now())
            returning id::text
          `,
          [input.phone],
        );

    if (phoneProviderId && input.existingProviderId && phoneProviderId !== input.existingProviderId) {
      await client.query("update quotes set provider_id = $1 where provider_id = $2", [
        phoneProviderId,
        input.existingProviderId,
      ]);
      await client.query("update customers set provider_id = $1 where provider_id = $2", [
        phoneProviderId,
        input.existingProviderId,
      ]);
    }

    const sessionToken = token();
    await client.query(
      `
        insert into provider_sessions (provider_id, token, channel)
        values ($1, $2, 'phone')
      `,
      [provider.rows[0].id, sessionToken],
    );
    await client.query("delete from phone_otps where phone = $1", [input.phone]);

    return {
      token: sessionToken,
      provider: await getProviderById(client, provider.rows[0].id),
    };
  });
}

export async function saveProviderPin(db: Database, providerId: string, input: { pin: string }) {
  const result = await db.query(
    `
      update providers
      set pin_hash = crypt($2, gen_salt('bf')),
        pin_set_at = now()
      where id = $1 and phone_verified_at is not null
      returning id::text
    `,
    [providerId, input.pin],
  );

  if (!result.rows[0]) {
    return null;
  }

  return getProviderById(db, result.rows[0].id);
}

export async function signInWithGoogle(
  db: Database,
  input: { profile: GoogleProfile; existingProviderId?: string },
) {
  const { profile, existingProviderId } = input;

  return withTransaction(db, async (client) => {
    const bySub = await client.query(
      "select id::text from providers where google_sub = $1 limit 1",
      [profile.sub],
    );

    let providerId: string | undefined = bySub.rows[0]?.id;

    if (!providerId) {
      const byEmail = await client.query(
        "select id::text from providers where lower(google_email) = lower($1) limit 1",
        [profile.email],
      );
      providerId = byEmail.rows[0]?.id;
    }

    if (!providerId && existingProviderId) {
      const draft = await client.query(
        "select id::text from providers where id = $1 and google_sub is null limit 1",
        [existingProviderId],
      );
      providerId = draft.rows[0]?.id;
    }

    if (providerId) {
      await client.query(
        `
          update providers
          set google_sub = $2,
            google_email = $3,
            google_picture_url = coalesce($4, google_picture_url),
            business_name = case when business_name = '' and $5 <> '' then $5 else business_name end
          where id = $1
        `,
        [
          providerId,
          profile.sub,
          profile.email,
          profile.pictureUrl ?? null,
          profile.name,
        ],
      );
    } else {
      const inserted = await client.query(
        `
          insert into providers (business_name, google_sub, google_email, google_picture_url)
          values ($1, $2, $3, $4)
          returning id::text
        `,
        [profile.name, profile.sub, profile.email, profile.pictureUrl ?? null],
      );
      providerId = inserted.rows[0].id as string;
    }

    const sessionToken = token();
    await client.query(
      `
        insert into provider_sessions (provider_id, token, channel)
        values ($1, $2, 'google')
      `,
      [providerId, sessionToken],
    );

    return {
      token: sessionToken,
      provider: await getProviderById(client, providerId),
    };
  });
}

export async function loginWithPin(db: Database, input: { phone: string; pin: string }) {
  return withTransaction(db, async (client) => {
    const provider = await client.query(
      `
        select id::text
        from providers
        where account_phone = $1
          and phone_verified_at is not null
          and pin_hash is not null
          and pin_hash = crypt($2, pin_hash)
        limit 1
      `,
      [input.phone, input.pin],
    );

    const providerId = provider.rows[0]?.id;
    if (!providerId) {
      return null;
    }

    const sessionToken = token();
    await client.query(
      `
        insert into provider_sessions (provider_id, token, channel)
        values ($1, $2, 'pin')
      `,
      [providerId, sessionToken],
    );

    return {
      token: sessionToken,
      provider: await getProviderById(client, providerId),
    };
  });
}

export async function getProviderById(db: DatabaseClient, providerId: string): Promise<ProviderProfileDto> {
  const result = await db.query(
    `
      select p.id::text, p.business_name, p.service_line, p.customer_phone,
        p.account_phone, p.phone_verified_at, p.pin_set_at, p.has_logo,
        p.google_sub, p.google_email, p.google_picture_url,
        pa.bank_name as payout_bank_name,
        pa.account_number_last4
      from providers p
      left join lateral (
        select bank_name, account_number_last4
        from payout_accounts
        where provider_id = p.id
        order by is_default desc, created_at desc
        limit 1
      ) pa on true
      where p.id = $1
    `,
    [providerId],
  );

  if (!result.rows[0]) {
    throw new Error("Provider not found.");
  }

  return mapProvider(result.rows[0]);
}

export async function getProviderByToken(db: DatabaseClient, bearerToken: string): Promise<ProviderProfileDto | null> {
  const result = await db.query(
    `
      select p.id::text, p.business_name, p.service_line, p.customer_phone,
        p.account_phone, p.phone_verified_at, p.pin_set_at, p.has_logo,
        p.google_sub, p.google_email, p.google_picture_url,
        pa.bank_name as payout_bank_name,
        pa.account_number_last4
      from provider_sessions s
      join providers p on p.id = s.provider_id
      left join lateral (
        select bank_name, account_number_last4
        from payout_accounts
        where provider_id = p.id
        order by is_default desc, created_at desc
        limit 1
      ) pa on true
      where s.token = $1 and (s.expires_at is null or s.expires_at > now())
      limit 1
    `,
    [bearerToken],
  );

  return result.rows[0] ? mapProvider(result.rows[0]) : null;
}

export async function updateProviderProfile(
  db: Database,
  providerId: string,
  input: { businessName: string; serviceLine: string; customerPhone: string },
) {
  const result = await withTransaction(db, async (client) => {
    const updated = await client.query(
      `
        update providers
        set business_name = $2, service_line = $3, customer_phone = $4
        where id = $1
        returning id::text
      `,
      [providerId, input.businessName, input.serviceLine, input.customerPhone],
    );

    const defaultCompany = await ensureDefaultCompany(client, providerId, input);
    await client.query(
      `
        update provider_companies
        set business_name = $2, service_line = $3, customer_phone = $4
        where id = $1
      `,
      [defaultCompany.id, input.businessName, input.serviceLine, input.customerPhone],
    );

    return updated;
  });

  return getProviderById(db, result.rows[0].id);
}

export async function listPayoutAccounts(db: Database, providerId: string): Promise<PayoutAccountDto[]> {
  const result = await db.query(
    `
      select id::text, provider_id::text, bank_name, bank_code, account_number_last4, account_name, is_default
      from payout_accounts
      where provider_id = $1
      order by is_default desc, created_at desc
    `,
    [providerId],
  );

  return result.rows.map(mapPayoutAccount);
}

export async function createPayoutAccount(
  db: Database,
  providerId: string,
  input: {
    bankName: string;
    accountLast4: string;
    bankCode?: string;
    accountName?: string;
    paystackRecipientCode?: string;
    makeDefault?: boolean;
  },
) {
  return withTransaction(db, async (client) => {
    const existing = await client.query("select 1 from payout_accounts where provider_id = $1 limit 1", [providerId]);
    const isDefault = input.makeDefault || existing.rows.length === 0;

    if (isDefault) {
      await client.query("update payout_accounts set is_default = false where provider_id = $1", [providerId]);
    }

    const result = await client.query(
      `
        insert into payout_accounts (
          provider_id, bank_name, bank_code, account_number_last4, account_name, paystack_recipient_code, is_default
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id::text, provider_id::text, bank_name, bank_code, account_number_last4, account_name, is_default
      `,
      [
        providerId,
        input.bankName,
        input.bankCode ?? null,
        input.accountLast4,
        input.accountName ?? null,
        input.paystackRecipientCode ?? null,
        isDefault,
      ],
    );

    return mapPayoutAccount(result.rows[0]);
  });
}

export async function setDefaultPayoutAccount(db: Database, providerId: string, payoutAccountId: string) {
  return withTransaction(db, async (client) => {
    const existing = await client.query(
      "select id::text from payout_accounts where id = $1 and provider_id = $2 limit 1",
      [payoutAccountId, providerId],
    );

    if (!existing.rows[0]) {
      return null;
    }

    await client.query("update payout_accounts set is_default = false where provider_id = $1", [providerId]);
    const result = await client.query(
      `
        update payout_accounts
        set is_default = true
        where id = $1
        returning id::text, provider_id::text, bank_name, bank_code, account_number_last4, account_name, is_default
      `,
      [payoutAccountId],
    );

    return mapPayoutAccount(result.rows[0]);
  });
}

export async function savePayoutAccount(
  db: Database,
  providerId: string,
  input: {
    bankName: string;
    accountLast4: string;
    bankCode?: string;
    accountName?: string;
    paystackRecipientCode?: string;
  },
) {
  await createPayoutAccount(db, providerId, { ...input, makeDefault: true });
  return getProviderById(db, providerId);
}

export async function createQuote(
  db: Database,
  providerId: string,
  input: {
    companyId?: string;
    customerName: string;
    customerPhone: string;
    customerLocation: string;
    prompt: string;
    collectDeposit: boolean;
    jobTitle?: string;
    description?: string;
    items?: Array<{
      title: string;
      quantityLabel: string;
      unitAmount: number;
      totalAmount: number;
    }>;
  },
) {
  return withTransaction(db, async (client) => {
    const requestedCompany = input.companyId ? await getCompanyById(client, input.companyId) : null;
    if (input.companyId && requestedCompany?.providerId !== providerId) {
      return null;
    }
    const company = requestedCompany ?? (await ensureDefaultCompany(client, providerId));
    const generated =
      quoteFromProvidedItems(input) ??
      (await generateQuoteFromPrompt({
        ...input,
        businessName: company.businessName,
        serviceLine: company.serviceLine,
      }));
    const customer = await client.query(
      `
        insert into customers (provider_id, name, phone, location)
        values ($1, $2, $3, $4)
        returning id
      `,
      [providerId, input.customerName, input.customerPhone, input.customerLocation],
    );

    const inserted = await client.query(
      `
        insert into quotes (
          quote_number, public_slug, provider_id, customer_id, customer_name, customer_phone,
          customer_location, job_title, description, prompt, subtotal_amount, vat_amount,
          total_amount, deposit_amount, collect_deposit, valid_until, company_id
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        returning *
      `,
      [
        quoteNumber(),
        publicSlug(),
        providerId,
        customer.rows[0].id,
        input.customerName,
        input.customerPhone,
        input.customerLocation,
        generated.jobTitle,
        generated.description,
        input.prompt,
        generated.subtotalAmount,
        generated.vatAmount,
        generated.totalAmount,
        generated.depositAmount,
        input.collectDeposit,
        generated.validUntil,
        company.id,
      ],
    );

    for (const [index, item] of generated.items.entries()) {
      await client.query(
        `
          insert into quote_items (quote_id, title, quantity_label, unit_amount, total_amount, sort_order)
          values ($1, $2, $3, $4, $5, $6)
        `,
        [inserted.rows[0].id, item.title, item.quantityLabel, item.unitAmount, item.totalAmount, index],
      );
    }

    await client.query(
      "insert into quote_events (quote_id, kind, label) values ($1, 'drafted', 'Quote drafted')",
      [inserted.rows[0].id],
    );

    return mapQuote(inserted.rows[0], await getQuoteItems(client, inserted.rows[0].id), company);
  });
}

export async function updateQuote(
  db: Database,
  providerId: string,
  slugOrId: string,
  input: {
    collectDeposit?: boolean;
    status?: QuoteStatus;
    customerName?: string;
    customerPhone?: string;
    customerLocation?: string;
    prompt?: string;
    aiEditMode?: "replace" | "applyAdditionalInfo";
    jobTitle?: string;
    description?: string;
    items?: Array<{
      title: string;
      quantityLabel: string;
      unitAmount: number;
      totalAmount: number;
    }>;
  },
) {
  return withTransaction(db, async (client) => {
    const existing = await findQuoteRow(client, slugOrId);

    if (!existing || existing.provider_id !== providerId) {
      return null;
    }

    const collectDeposit = input.collectDeposit ?? existing.collect_deposit;
    const company = await getQuoteCompany(client, existing.company_id);
    const existingItems = await getQuoteItems(client, existing.id);
    const regenerated = input.prompt
      ? await generateQuoteFromPrompt({
          prompt: input.prompt,
          collectDeposit,
          businessName: company?.businessName,
          serviceLine: company?.serviceLine,
        })
      : null;
    const items =
      input.items ??
      (input.aiEditMode === "applyAdditionalInfo" && regenerated
        ? [
            ...existingItems.map(({ title, quantityLabel, unitAmount, totalAmount }) => ({
              title,
              quantityLabel,
              unitAmount,
              totalAmount,
            })),
            ...regenerated.items.filter(
              (item) =>
                !existingItems.some(
                  (existingItem) => existingItem.title.trim().toLowerCase() === item.title.trim().toLowerCase(),
                ),
            ),
          ]
        : regenerated?.items);
    const subtotalAmount = items?.reduce((sum, item) => sum + item.totalAmount, 0) ?? existing.subtotal_amount;
    const vatAmount = items ? Math.round(subtotalAmount * 0.075) : existing.vat_amount;
    const totalAmount = subtotalAmount + vatAmount;
    const depositAmount = collectDeposit ? Math.round(totalAmount * 0.5) : 0;
    const status = input.status ?? existing.status;

    const result = await client.query(
      `
        update quotes
        set customer_name = $2,
            customer_phone = $3,
            customer_location = $4,
            job_title = $5,
            description = $6,
            prompt = $7,
            subtotal_amount = $8,
            vat_amount = $9,
            total_amount = $10,
            collect_deposit = $11,
            deposit_amount = $12,
            status = $13
        where id = $1
        returning *
      `,
      [
        existing.id,
        input.customerName ?? existing.customer_name,
        input.customerPhone ?? existing.customer_phone,
        input.customerLocation ?? existing.customer_location,
        input.jobTitle ?? regenerated?.jobTitle ?? existing.job_title,
        input.description ?? regenerated?.description ?? existing.description,
        input.prompt ?? existing.prompt,
        subtotalAmount,
        vatAmount,
        totalAmount,
        collectDeposit,
        depositAmount,
        status,
      ],
    );

    if (items) {
      await client.query("delete from quote_items where quote_id = $1", [existing.id]);
      for (const [index, item] of items.entries()) {
        await client.query(
          `
            insert into quote_items (quote_id, title, quantity_label, unit_amount, total_amount, sort_order)
            values ($1, $2, $3, $4, $5, $6)
          `,
          [existing.id, item.title, item.quantityLabel, item.unitAmount, item.totalAmount, index],
        );
      }
    }

    return mapQuote(
      result.rows[0],
      await getQuoteItems(client, existing.id),
      company,
    );
  });
}

export async function listQuotes(db: Database, providerId: string): Promise<QuoteDto[]> {
  const result = await db.query(
    "select * from quotes where provider_id = $1 and status <> 'archived' order by created_at desc",
    [providerId],
  );

  const quotes: QuoteDto[] = [];
  for (const row of result.rows) {
    quotes.push(mapQuote(row, await getQuoteItems(db, row.id), await getQuoteCompany(db, row.company_id)));
  }

  return quotes;
}

export type QuoteListFilter = "all" | "unpaid" | "viewed" | "drafts";

function quoteListFilterSql(filter: QuoteListFilter) {
  return {
    all: "status <> 'archived'",
    unpaid: "status in ('sent', 'viewed', 'accepted', 'partial', 'expired')",
    viewed: "status = 'viewed'",
    drafts: "status = 'draft'",
  }[filter];
}

export async function listQuotePage(
  db: Database,
  providerId: string,
  input: {
    filter: QuoteListFilter;
    limit: number;
    offset: number;
    search?: string;
    serviceLine?: string;
  },
): Promise<{ quotes: QuoteDto[]; total: number; limit: number; offset: number; categories: string[] }> {
  const conditions = [`q.provider_id = $1`, quoteListFilterSql(input.filter).replaceAll("status", "q.status")];
  const params: Array<string | number> = [providerId];

  if (input.search?.trim()) {
    params.push(`%${input.search.trim().toLowerCase()}%`);
    conditions.push(
      `(lower(q.job_title) like $${params.length} or lower(q.customer_name) like $${params.length} or lower(q.description) like $${params.length})`,
    );
  }

  if (input.serviceLine?.trim()) {
    params.push(input.serviceLine.trim());
    conditions.push(`pc.service_line = $${params.length}`);
  }

  const where = conditions.join(" and ");
  const categories = await db.query(
    `
      select distinct pc.service_line
      from provider_companies pc
      where pc.provider_id = $1
        and pc.service_line <> ''
        and exists (
          select 1
          from quotes q
          where q.provider_id = pc.provider_id
            and q.company_id = pc.id
            and q.status <> 'archived'
        )
      order by pc.service_line asc
    `,
    [providerId],
  );
  const total = await db.query(
    `
      select count(*)::int as total
      from quotes q
      left join provider_companies pc on pc.id = q.company_id
      where ${where}
    `,
    params,
  );
  const pageParams = [...params, input.limit, input.offset];
  const result = await db.query(
    `
      select q.*
      from quotes q
      left join provider_companies pc on pc.id = q.company_id
      where ${where}
      order by q.created_at desc
      limit $${pageParams.length - 1} offset $${pageParams.length}
    `,
    pageParams,
  );

  const quotes: QuoteDto[] = [];
  for (const row of result.rows) {
    quotes.push(mapQuote(row, await getQuoteItems(db, row.id), await getQuoteCompany(db, row.company_id)));
  }

  return {
    quotes,
    total: total.rows[0]?.total ?? 0,
    limit: input.limit,
    offset: input.offset,
    categories: categories.rows.map((row) => row.service_line).filter(Boolean),
  };
}

export async function archiveQuote(db: Database, providerId: string, slugOrId: string) {
  return withTransaction(db, async (client) => {
    const existing = await findQuoteRow(client, slugOrId);

    if (!existing || existing.provider_id !== providerId) {
      return null;
    }

    const result = await client.query(
      `
        update quotes
        set status = 'archived',
            updated_at = now()
        where id = $1
        returning *
      `,
      [existing.id],
    );

    await client.query("insert into quote_events (quote_id, kind, label) values ($1, 'archived', 'Quote archived')", [
      existing.id,
    ]);

    return mapQuote(
      result.rows[0],
      await getQuoteItems(client, existing.id),
      await getQuoteCompany(client, result.rows[0].company_id),
    );
  });
}

export async function getOrCreateQuoteEditDraft(db: Database, providerId: string, slugOrId: string) {
  return withTransaction(db, async (client) => {
    const source = await findQuoteRow(client, slugOrId);

    if (!source || source.provider_id !== providerId || source.status === "archived") {
      return null;
    }

    return mapQuote(
      source,
      await getQuoteItems(client, source.id),
      await getQuoteCompany(client, source.company_id),
    );
  });
}

export async function deleteQuote(db: Database, providerId: string, slugOrId: string) {
  const existing = await findQuoteRow(db, slugOrId);

  if (!existing || existing.provider_id !== providerId) {
    return false;
  }

  await db.query("delete from quotes where id = $1", [existing.id]);
  return true;
}

export async function getProviderQuote(db: Database, providerId: string, slugOrId: string) {
  const row = await findQuoteRow(db, slugOrId);

  if (!row || row.provider_id !== providerId) {
    return null;
  }

  return mapQuote(row, await getQuoteItems(db, row.id), await getQuoteCompany(db, row.company_id));
}

export async function getProviderQuoteDetail(
  db: Database,
  providerId: string,
  slugOrId: string,
): Promise<{ quote: QuoteDto; timeline: QuoteEventDto[] } | null> {
  const row = await findQuoteRow(db, slugOrId);

  if (!row || row.provider_id !== providerId) {
    return null;
  }

  const quote = mapQuote(row, await getQuoteItems(db, row.id), await getQuoteCompany(db, row.company_id));
  const timeline = await getQuoteEvents(db, row.id);

  return { quote, timeline };
}

export async function getPublicQuoteBundle(db: DatabaseClient, slugOrId: string): Promise<QuoteBundleDto | null> {
  const row = await findQuoteRow(db, slugOrId);

  if (!row || row.status === "archived") {
    return null;
  }

  return {
    quote: mapQuote(row, await getQuoteItems(db, row.id), await getQuoteCompany(db, row.company_id)),
    provider: await getProviderById(db, row.provider_id),
    timeline: await getQuoteEvents(db, row.id),
    feedback: await getQuoteFeedback(db, row.id),
  };
}

export async function recordQuoteSend(
  db: Database,
  providerId: string,
  slugOrId: string,
  input: { channel: string; destination?: string },
) {
  return withTransaction(db, async (client) => {
    const row = await findQuoteRow(client, slugOrId);

    if (!row || row.provider_id !== providerId) {
      return null;
    }

    await client.query(
      `
        insert into send_attempts (quote_id, channel, destination)
        values ($1, $2, $3)
      `,
      [row.id, input.channel, input.destination ?? null],
    );
    await client.query(
      `
        update quotes
        set status = case when status = 'draft' then 'sent' else status end, sent_at = coalesce(sent_at, now())
        where id = $1
      `,
      [row.id],
    );
    await client.query(
      "insert into quote_events (quote_id, kind, label) values ($1, 'sent', $2)",
      [row.id, `Sent via ${input.channel}`],
    );

    return getPublicQuoteBundle(client, row.public_slug);
  });
}

export async function recordPublicView(db: Database, slugOrId: string): Promise<QuotePublicActionResult | null> {
  return withTransaction(db, async (client) => {
    const row = await findQuoteRow(client, slugOrId);

    if (!row || row.status === "archived") {
      return null;
    }

    const shouldRecordView = ["draft", "sent"].includes(row.status as string);
    await client.query(
      `
        update quotes
        set status = case when status in ('draft', 'sent') then 'viewed' else status end
        where id = $1
      `,
      [row.id],
    );

    const providerId = row.provider_id as string;
    const quoteId = row.id as string;
    const customerLabel = (row.customer_name as string) || "A customer";
    const title = "Quote viewed";
    const body = `${customerLabel} viewed your quote`;
    let pushTarget: NotificationPushPayload | undefined;

    if (shouldRecordView) {
      await client.query(
        "insert into quote_events (quote_id, kind, label) values ($1, 'viewed', 'Quote viewed')",
        [row.id],
      );
      const notificationId = await insertQuoteProviderNotification(client, {
        providerId,
        quoteId,
        kind: "viewed",
        title,
        body,
        metadata: { quoteNumber: row.quote_number },
      });
      pushTarget = {
        providerId,
        notificationId,
        quoteId,
        kind: "viewed",
        title,
        body,
      };
    }

    const bundle = await getPublicQuoteBundle(client, row.public_slug);
    if (!bundle) {
      throw new Error("Quote bundle missing after public view.");
    }

    return { bundle, pushTarget };
  });
}

export async function recordPublicAccept(db: Database, slugOrId: string): Promise<QuotePublicActionResult | null> {
  return withTransaction(db, async (client) => {
    const row = await findQuoteRow(client, slugOrId);

    if (!row || row.status === "archived") {
      return null;
    }

    await client.query(
      "update quotes set status = 'accepted', accepted_at = coalesce(accepted_at, now()) where id = $1",
      [row.id],
    );
    await client.query(
      "insert into quote_events (quote_id, kind, label) values ($1, 'accepted', 'Customer accepted quote')",
      [row.id],
    );

    const providerId = row.provider_id as string;
    const quoteId = row.id as string;
    const customerLabel = (row.customer_name as string) || "A customer";
    const title = "Quote accepted";
    const body = `${customerLabel} accepted your quote`;
    const notificationId = await insertQuoteProviderNotification(client, {
      providerId,
      quoteId,
      kind: "accepted",
      title,
      body,
      metadata: { quoteNumber: row.quote_number },
    });

    const bundle = await getPublicQuoteBundle(client, row.public_slug);
    if (!bundle) {
      throw new Error("Quote bundle missing after public accept.");
    }

    const pushTarget: NotificationPushPayload = {
      providerId,
      notificationId,
      quoteId,
      kind: "accepted",
      title,
      body,
    };

    return { bundle, pushTarget };
  });
}

export async function recordQuoteClientFeedback(
  db: Database,
  slugOrId: string,
  input: { type: "revision_request" | "review"; message: string; rating?: number },
): Promise<QuotePublicActionResult | null> {
  return withTransaction(db, async (client) => {
    const row = await findQuoteRow(client, slugOrId);

    if (!row || row.status === "archived") {
      return null;
    }

    const providerId = row.provider_id as string;
    const quoteId = row.id as string;
    await client.query(
      `
        insert into quote_client_feedback (quote_id, provider_id, type, message, rating)
        values ($1, $2, $3, $4, $5)
      `,
      [quoteId, providerId, input.type, input.message, input.rating ?? null],
    );

    const kind = input.type === "review" ? "review_received" : "revision_requested";
    const eventLabel =
      input.type === "review"
        ? `Customer review (${input.rating ?? 0}/5): ${input.message}`
        : `Revision requested: ${input.message}`;
    await client.query("insert into quote_events (quote_id, kind, label) values ($1, $2, $3)", [
      quoteId,
      kind,
      eventLabel,
    ]);

    const customerLabel = (row.customer_name as string) || "A customer";
    const title = input.type === "review" ? "New quote review" : "Quote revision requested";
    const body =
      input.type === "review"
        ? `${customerLabel} left a ${input.rating ?? 0}-star review`
        : `${customerLabel} requested changes to your quote`;
    const notificationId = await insertQuoteProviderNotification(client, {
      providerId,
      quoteId,
      kind,
      title,
      body,
      metadata: {
        quoteNumber: row.quote_number,
        message: input.message,
        rating: input.rating ?? null,
      },
    });

    const bundle = await getPublicQuoteBundle(client, row.public_slug);
    if (!bundle) {
      throw new Error("Quote bundle missing after client feedback.");
    }

    return {
      bundle,
      pushTarget: {
        providerId,
        notificationId,
        quoteId,
        kind,
        title,
        body,
      },
    };
  });
}

export async function createInitializedPayment(
  db: Database,
  input: {
    publicSlug: string;
    email: string;
    channel: string;
    amount: number;
    reference: string;
    purpose: PaymentPurpose;
  },
) {
  const row = await findQuoteRow(db, input.publicSlug);

  if (!row || row.status === "archived") {
    return null;
  }

  await db.query(
    `
      insert into payments (quote_id, paystack_reference, email, channel, amount, purpose, status)
      values ($1, $2, $3, $4, $5, $6, 'initialized')
      on conflict (paystack_reference) do update
      set email = excluded.email,
          channel = excluded.channel,
          amount = excluded.amount,
          purpose = excluded.purpose,
          status = 'initialized'
    `,
    [row.id, input.reference, input.email, input.channel, input.amount, input.purpose],
  );

  return row;
}

export async function getPublicPaymentByReference(
  db: DatabaseClient,
  input: { publicSlug: string; reference: string },
): Promise<PaymentRecordDto | null> {
  const result = await db.query(
    `
      select p.id::text, q.quote_number, p.amount, p.paystack_reference, p.status, p.purpose
      from payments p
      join quotes q on q.id = p.quote_id
      where p.paystack_reference = $1
        and lower(q.public_slug) = lower($2)
        and q.status <> 'archived'
      limit 1
    `,
    [input.reference, input.publicSlug],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    quoteId: row.quote_number,
    amount: row.amount,
    reference: row.paystack_reference,
    status: row.status,
    purpose: row.purpose,
  };
}

export async function applyPaymentTransition(
  db: Database,
  input: {
    reference: string;
    status: PaymentStatus;
    eventLabel: string;
    rawPayload: unknown;
  },
): Promise<{ paymentRow: QueryResultRow; pushTarget?: NotificationPushPayload } | null> {
  return withTransaction(db, async (client) => {
    const payment = await client.query(
      `
        update payments
        set status = $2,
          paid_at = case when $2 = 'paid' then coalesce(paid_at, now()) else paid_at end,
          raw_payload = $3
        where paystack_reference = $1
        returning *
      `,
      [input.reference, input.status, JSON.stringify(input.rawPayload)],
    );

    if (!payment.rows[0]) {
      return null;
    }

    const paymentRow = payment.rows[0];
    let pushTarget: NotificationPushPayload | undefined;

    const quoteMeta = await client.query(
      `select provider_id::text, customer_name, quote_number from quotes where id = $1`,
      [paymentRow.quote_id],
    );
    const quoteRow = quoteMeta.rows[0];
    const providerId = quoteRow ? (quoteRow.provider_id as string) : undefined;
    const quoteId = paymentRow.quote_id as string;

    if (input.status === "paid") {
      const purpose = (paymentRow.purpose ?? "deposit") as PaymentPurpose;
      const quoteStatus = purpose === "balance" ? "paid" : "partial";
      const eventKind = purpose === "balance" ? "balance_paid" : "deposit_paid";
      const notificationKind = purpose === "balance" ? "balance_paid" : "deposit_paid";
      const eventLabel = purpose === "balance" ? input.eventLabel.replace(/^Deposit/i, "Balance") : input.eventLabel;
      await client.query(
        "update quotes set status = $2, paid_at = coalesce(paid_at, now()) where id = $1",
        [paymentRow.quote_id, quoteStatus],
      );
      await client.query("insert into quote_events (quote_id, kind, label) values ($1, $2, $3)", [
        paymentRow.quote_id,
        eventKind,
        eventLabel,
      ]);
      if (providerId && quoteRow) {
        const customerLabel = (quoteRow.customer_name as string) || "A customer";
        const title = purpose === "balance" ? "Balance received" : "Deposit received";
        const body =
          purpose === "balance"
            ? `Balance paid for ${customerLabel}'s quote`
            : `Deposit paid for ${customerLabel}'s quote`;
        const notificationId = await insertQuoteProviderNotification(client, {
          providerId,
          quoteId,
          kind: notificationKind,
          title,
          body,
          metadata: {
            quoteNumber: quoteRow.quote_number as string,
            paystackReference: input.reference,
            purpose,
          },
        });
        pushTarget = {
          providerId,
          notificationId,
          quoteId,
          kind: notificationKind,
          title,
          body,
        };
      }
    } else if (input.status === "failed") {
      await client.query(
        "insert into quote_events (quote_id, kind, label) values ($1, 'payment_failed', $2)",
        [paymentRow.quote_id, input.eventLabel],
      );
      if (providerId && quoteRow) {
        const customerLabel = (quoteRow.customer_name as string) || "A customer";
        const title = "Payment failed";
        const body = `Payment failed for ${customerLabel}'s quote`;
        const notificationId = await insertQuoteProviderNotification(client, {
          providerId,
          quoteId,
          kind: "payment_failed",
          title,
          body,
          metadata: { quoteNumber: quoteRow.quote_number, paystackReference: input.reference },
        });
        pushTarget = {
          providerId,
          notificationId,
          quoteId,
          kind: "payment_failed",
          title,
          body,
        };
      }
    }

    return { paymentRow, pushTarget };
  });
}

export async function getDashboard(db: Database, providerId: string) {
  const summary = await db.query(
    `
      select
        coalesce(sum(case when status in ('partial', 'paid') then total_amount else 0 end), 0)::int as paid_total,
        count(*)::int as quote_count,
        count(*) filter (where status in ('sent', 'viewed'))::int as active_count,
        count(*) filter (where status in ('accepted', 'partial', 'paid'))::int as accepted_count
      from quotes
      where provider_id = $1 and status <> 'archived'
    `,
    [providerId],
  );
  const recentQuotes = await listQuotePage(db, providerId, {
    filter: "all",
    limit: 5,
    offset: 0,
  });

  return {
    paidTotal: summary.rows[0].paid_total,
    quoteCount: summary.rows[0].quote_count,
    activeCount: summary.rows[0].active_count,
    acceptedCount: summary.rows[0].accepted_count,
    recentQuotes: recentQuotes.quotes,
  };
}

export async function getEarnings(db: Database, providerId: string) {
  const result = await db.query(
    `
      select
        coalesce(sum(p.amount) filter (where p.status = 'paid'), 0)::int as paid_amount,
        count(p.*) filter (where p.status = 'paid')::int as paid_count
      from payments p
      join quotes q on q.id = p.quote_id
      where q.provider_id = $1 and q.status <> 'archived'
    `,
    [providerId],
  );

  const customers = await db.query(
    `
      select customer_name, coalesce(sum(total_amount), 0)::int as total_amount
      from quotes
      where provider_id = $1 and status in ('partial', 'paid')
        and status <> 'archived'
      group by customer_name
      order by total_amount desc
      limit 5
    `,
    [providerId],
  );

  return {
    paidAmount: result.rows[0].paid_amount,
    paidCount: result.rows[0].paid_count,
    topCustomers: customers.rows.map((row) => ({
      name: row.customer_name,
      amount: row.total_amount,
    })),
  };
}
