import { randomBytes } from "node:crypto";

import type { QueryResultRow } from "pg";

import type {
  CompanyProfileDto,
  PaymentStatus,
  PayoutAccountDto,
  ProviderProfileDto,
  QuoteBundleDto,
  QuoteDto,
  QuoteEventDto,
  QuoteLineItemDto,
  QuoteStatus,
} from "./domain.js";
import type { Database, DatabaseClient } from "./db/pool.js";
import { withTransaction } from "./db/pool.js";
import { generateQuoteFromPrompt } from "./quotes/quote-engine.js";

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

function mapProvider(row: QueryResultRow): ProviderProfileDto {
  return {
    id: row.id,
    businessName: row.business_name,
    serviceLine: row.service_line,
    customerPhone: row.customer_phone,
    accountPhone: row.account_phone ?? undefined,
    hasAccount: Boolean(row.phone_verified_at),
    hasPin: Boolean(row.pin_set_at),
    hasLogo: row.has_logo,
    hasPayoutAccount: Boolean(row.payout_bank_name),
    payoutBankName: row.payout_bank_name ?? undefined,
    payoutAccountLast4: row.account_number_last4 ?? undefined,
  };
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

export async function startPhoneOtp(db: Database, input: { phone: string }) {
  const code = "123456";
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

  return {
    phone: input.phone,
    expiresAt: expiresAt.toISOString(),
    code,
  };
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
      select id::text, provider_id::text, bank_name, account_number_last4, account_name, is_default
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
  input: { bankName: string; accountLast4: string; accountName?: string; makeDefault?: boolean },
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
          provider_id, bank_name, account_number_last4, account_name, is_default
        )
        values ($1, $2, $3, $4, $5)
        returning id::text, provider_id::text, bank_name, account_number_last4, account_name, is_default
      `,
      [providerId, input.bankName, input.accountLast4, input.accountName ?? null, isDefault],
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
        returning id::text, provider_id::text, bank_name, account_number_last4, account_name, is_default
      `,
      [payoutAccountId],
    );

    return mapPayoutAccount(result.rows[0]);
  });
}

export async function savePayoutAccount(
  db: Database,
  providerId: string,
  input: { bankName: string; accountLast4: string; accountName?: string },
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
  },
) {
  return withTransaction(db, async (client) => {
    const requestedCompany = input.companyId ? await getCompanyById(client, input.companyId) : null;
    if (input.companyId && requestedCompany?.providerId !== providerId) {
      return null;
    }
    const company = requestedCompany ?? (await ensureDefaultCompany(client, providerId));
    const generated = await generateQuoteFromPrompt(input);
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
  input: { collectDeposit?: boolean; status?: QuoteStatus },
) {
  const existing = await findQuoteRow(db, slugOrId);

  if (!existing || existing.provider_id !== providerId) {
    return null;
  }

  const collectDeposit = input.collectDeposit ?? existing.collect_deposit;
  const depositAmount = collectDeposit ? Math.round(existing.total_amount * 0.5) : 0;
  const status = input.status ?? existing.status;

  const result = await db.query(
    `
      update quotes
      set collect_deposit = $2, deposit_amount = $3, status = $4
      where id = $1
      returning *
    `,
    [existing.id, collectDeposit, depositAmount, status],
  );

  return mapQuote(
    result.rows[0],
    await getQuoteItems(db, existing.id),
    await getQuoteCompany(db, result.rows[0].company_id),
  );
}

export async function listQuotes(db: Database, providerId: string): Promise<QuoteDto[]> {
  const result = await db.query(
    "select * from quotes where provider_id = $1 order by created_at desc",
    [providerId],
  );

  const quotes: QuoteDto[] = [];
  for (const row of result.rows) {
    quotes.push(mapQuote(row, await getQuoteItems(db, row.id), await getQuoteCompany(db, row.company_id)));
  }

  return quotes;
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

  if (!row) {
    return null;
  }

  return {
    quote: mapQuote(row, await getQuoteItems(db, row.id), await getQuoteCompany(db, row.company_id)),
    provider: await getProviderById(db, row.provider_id),
    timeline: await getQuoteEvents(db, row.id),
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

export async function recordPublicView(db: Database, slugOrId: string) {
  return withTransaction(db, async (client) => {
    const row = await findQuoteRow(client, slugOrId);

    if (!row) {
      return null;
    }

    await client.query(
      `
        update quotes
        set status = case when status in ('draft', 'sent') then 'viewed' else status end
        where id = $1
      `,
      [row.id],
    );
    await client.query(
      "insert into quote_events (quote_id, kind, label) values ($1, 'viewed', 'Quote viewed')",
      [row.id],
    );

    return getPublicQuoteBundle(client, row.public_slug);
  });
}

export async function recordPublicAccept(db: Database, slugOrId: string) {
  return withTransaction(db, async (client) => {
    const row = await findQuoteRow(client, slugOrId);

    if (!row) {
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

    return getPublicQuoteBundle(client, row.public_slug);
  });
}

export async function createInitializedPayment(
  db: Database,
  input: { publicSlug: string; email: string; channel: string; amount: number; reference: string },
) {
  const row = await findQuoteRow(db, input.publicSlug);

  if (!row) {
    return null;
  }

  await db.query(
    `
      insert into payments (quote_id, paystack_reference, email, channel, amount, status)
      values ($1, $2, $3, $4, $5, 'initialized')
      on conflict (paystack_reference) do update
      set email = excluded.email, channel = excluded.channel, amount = excluded.amount, status = 'initialized'
    `,
    [row.id, input.reference, input.email, input.channel, input.amount],
  );

  return row;
}

export async function applyPaymentTransition(
  db: Database,
  input: {
    reference: string;
    status: PaymentStatus;
    eventLabel: string;
    rawPayload: unknown;
  },
) {
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
    if (input.status === "paid") {
      await client.query(
        "update quotes set status = 'partial', paid_at = coalesce(paid_at, now()) where id = $1",
        [paymentRow.quote_id],
      );
      await client.query(
        "insert into quote_events (quote_id, kind, label) values ($1, 'deposit_paid', $2)",
        [paymentRow.quote_id, input.eventLabel],
      );
    } else if (input.status === "failed") {
      await client.query(
        "insert into quote_events (quote_id, kind, label) values ($1, 'payment_failed', $2)",
        [paymentRow.quote_id, input.eventLabel],
      );
    }

    return paymentRow;
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
      where provider_id = $1
    `,
    [providerId],
  );
  const recentQuotes = await listQuotes(db, providerId);

  return {
    paidTotal: summary.rows[0].paid_total,
    quoteCount: summary.rows[0].quote_count,
    activeCount: summary.rows[0].active_count,
    acceptedCount: summary.rows[0].accepted_count,
    recentQuotes: recentQuotes.slice(0, 5),
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
      where q.provider_id = $1
    `,
    [providerId],
  );

  const customers = await db.query(
    `
      select customer_name, coalesce(sum(total_amount), 0)::int as total_amount
      from quotes
      where provider_id = $1 and status in ('partial', 'paid')
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
