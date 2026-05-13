import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { corsOrigins, env } from "./config/env.js";
import type { Database } from "./db/pool.js";
import {
  companyProfileSchema,
  createQuoteSchema,
  googleSignInSchema,
  initializePaymentSchema,
  otpStartSchema,
  otpVerifySchema,
  payoutAccountResolveSchema,
  pinLoginSchema,
  pinSchema,
  payoutSchema,
  providerProfileSchema,
  pushTokenDeleteSchema,
  pushTokenUpsertSchema,
  sendQuoteSchema,
  signInSchema,
  updateQuoteSchema,
  type NotificationPushPayload,
} from "./domain.js";
import {
  applyPaymentTransition,
  archiveQuote,
  createCompany,
  createInitializedPayment,
  createPayoutAccount,
  createQuote,
  createSession,
  deletePushDevice,
  deleteQuote,
  getDashboard,
  getEarnings,
  getCompanyById,
  getOrCreateQuoteEditDraft,
  loginWithPin,
  listCompanies,
  listPayoutAccounts,
  listProviderNotifications,
  markProviderNotificationRead,
  getProviderByToken,
  getProviderQuote,
  getProviderQuoteDetail,
  getPublicPaymentByReference,
  getPublicQuoteBundle,
  listQuotePage,
  listQuotes,
  PhoneOtpDeliveryError,
  recordPublicAccept,
  recordPublicView,
  recordQuoteSend,
  savePayoutAccount,
  saveProviderPin,
  setDefaultPayoutAccount,
  signInWithGoogle,
  startPhoneOtp,
  updateCompany,
  updateCompanyLogo,
  updateProviderProfile,
  updateQuote,
  upsertPushDevice,
  verifyPhoneOtp,
} from "./repository.js";
import {
  GoogleAuthConfigError,
  GoogleAuthVerificationError,
  verifyGoogleIdToken,
  type GoogleProfile,
} from "./auth/google.js";
import {
  createWhatsAppOtpSender,
  type WhatsAppOtpSender,
} from "./notifications/whatsapp.js";
import {
  createPaystackTransferRecipient,
  initializePayment,
  listPaystackBanks,
  mapPaystackWebhookEvent,
  resolvePaystackBankAccount,
  verifyPaystackSignature,
  verifyPaystackTransaction,
} from "./payments/paystack.js";
import { dispatchQuotePush } from "./notifications/dispatch.js";
import { AiQuoteGenerationError } from "./quotes/quote-engine.js";
import {
  type CompanyLogoFile,
  LogoUploadConfigError,
  LogoUploadValidationError,
  uploadCompanyLogoToS3,
} from "./storage/company-logos.js";

type RawBodyRequest = FastifyRequest & { rawBody?: string };
type LogoUploader = (input: { providerId: string; companyId: string; file: CompanyLogoFile }) => Promise<string>;
type QuotePushDispatch = (db: Database, payload: NotificationPushPayload) => Promise<void>;
type GoogleIdTokenVerifier = (idToken: string) => Promise<GoogleProfile>;

async function verifyPayoutAccount(input: { bankName: string; bankCode: string; accountNumber: string }) {
  const resolved = await resolvePaystackBankAccount({
    accountNumber: input.accountNumber,
    bankCode: input.bankCode,
  });
  const recipient = await createPaystackTransferRecipient({
    accountNumber: resolved.accountNumber,
    bankCode: input.bankCode,
    accountName: resolved.accountName,
  });

  return {
    bankName: input.bankName,
    bankCode: input.bankCode,
    accountLast4: resolved.accountNumber.slice(-4),
    accountName: resolved.accountName,
    paystackRecipientCode: recipient.recipientCode,
  };
}

function getBearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  return header.slice("Bearer ".length).trim();
}

export function buildApp(
  db: Database,
  options: {
    logoUploader?: LogoUploader;
    pushDispatch?: QuotePushDispatch;
    otpSender?: WhatsAppOtpSender;
    googleIdTokenVerifier?: GoogleIdTokenVerifier;
    exposeOtpCode?: boolean;
  } = {},
) {
  const app = Fastify({
    logger: true,
  });
  const logoUploader = options.logoUploader ?? uploadCompanyLogoToS3;
  const runQuotePush = options.pushDispatch ?? dispatchQuotePush;
  const otpSender = options.otpSender ?? createWhatsAppOtpSender();
  const googleVerifier =
    options.googleIdTokenVerifier ?? ((idToken: string) => verifyGoogleIdToken(idToken));
  const exposeOtpCode = options.exposeOtpCode ?? env.EXPOSE_OTP_CODE;

  async function maybeDispatchPush(payload: NotificationPushPayload | undefined) {
    if (!payload) {
      return;
    }

    try {
      await runQuotePush(db, payload);
    } catch (error) {
      app.log.error(error);
    }
  }

  async function verifyPendingPayment(input: { reference: string; publicSlug: string }) {
    const existingPayment = await getPublicPaymentByReference(db, input);

    if (!existingPayment) {
      return null;
    }

    if (existingPayment.status === "paid" || existingPayment.status === "failed") {
      return existingPayment;
    }

    try {
      const verification = await verifyPaystackTransaction(input.reference);
      const transitionResult = await applyPaymentTransition(db, {
        reference: input.reference,
        status: verification.paymentStatus,
        eventLabel: verification.eventLabel,
        rawPayload: verification.rawPayload,
      });

      await maybeDispatchPush(transitionResult?.pushTarget);
    } catch (error) {
      app.log.error(error);
      return existingPayment;
    }

    return getPublicPaymentByReference(db, input);
  }

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const rawBody = typeof body === "string" ? body : body.toString("utf8");
    (request as RawBodyRequest).rawBody = rawBody;

    try {
      done(null, rawBody ? JSON.parse(rawBody) : {});
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.register(cors, {
    origin: corsOrigins,
  });
  app.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024,
      files: 1,
    },
  });

  async function requireProvider(request: FastifyRequest) {
    const token = getBearerToken(request);

    if (!token) {
      return null;
    }

    return getProviderByToken(db, token);
  }

  async function requireAccount(request: FastifyRequest) {
    const provider = await requireProvider(request);

    if (!provider?.hasAccount) {
      return null;
    }

    return provider;
  }

  app.get("/health", async () => {
    await db.query("select 1");
    return { ok: true };
  });

  app.post("/auth/session", async (request, reply) => {
    const body = signInSchema.parse(request.body);
    const session = await createSession(db, body);
    return reply.code(201).send(session);
  });

  app.post("/auth/otp/start", async (request, reply) => {
    const body = otpStartSchema.parse(request.body);
    try {
      const result = await startPhoneOtp(db, body, {
        sender: otpSender,
        exposeCode: exposeOtpCode,
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (error instanceof PhoneOtpDeliveryError) {
        request.log.error({ err: error }, "WhatsApp OTP delivery failed");
        return reply.code(503).send({
          message: "We could not send the WhatsApp OTP right now. Please try again shortly.",
        });
      }

      throw error;
    }
  });

  app.post("/auth/google", async (request, reply) => {
    const body = googleSignInSchema.parse(request.body);

    let profile: GoogleProfile;
    try {
      profile = await googleVerifier(body.idToken);
    } catch (error) {
      if (error instanceof GoogleAuthConfigError) {
        request.log.error({ err: error }, "Google sign-in is not configured");
        return reply.code(503).send({
          message: "Google sign-in is not configured on the server.",
        });
      }

      if (error instanceof GoogleAuthVerificationError) {
        return reply.code(401).send({ message: error.message });
      }

      throw error;
    }

    const existingProvider = await requireProvider(request);
    const session = await signInWithGoogle(db, {
      profile,
      existingProviderId: existingProvider?.id,
    });

    return reply.code(201).send(session);
  });

  app.post("/auth/otp/verify", async (request, reply) => {
    const body = otpVerifySchema.parse(request.body);
    const existingProvider = await requireProvider(request);
    const session = await verifyPhoneOtp(db, {
      ...body,
      existingProviderId: existingProvider?.id,
    });

    if (!session) {
      return reply.code(400).send({ message: "Invalid or expired OTP." });
    }

    return session;
  });

  app.post("/auth/login/pin", async (request, reply) => {
    const body = pinLoginSchema.parse(request.body);
    const session = await loginWithPin(db, body);

    if (!session) {
      return reply.code(401).send({ message: "Invalid phone or PIN." });
    }

    return session;
  });

  app.get("/providers/me", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    return provider;
  });

  app.put("/providers/me", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const body = providerProfileSchema.parse(request.body);
    return updateProviderProfile(db, provider.id, body);
  });

  app.put("/providers/me/pin", async (request, reply) => {
    const provider = await requireAccount(request);

    if (!provider) {
      return reply.code(403).send({ message: "Account required." });
    }

    const body = pinSchema.parse(request.body);
    const saved = await saveProviderPin(db, provider.id, body);

    if (!saved) {
      return reply.code(403).send({ message: "Account required." });
    }

    return saved;
  });

  app.put("/providers/me/payout", async (request, reply) => {
    const provider = await requireAccount(request);

    if (!provider) {
      return reply.code(403).send({ message: "Account required." });
    }

    const body = payoutSchema.parse(request.body);
    const payoutAccount = await verifyPayoutAccount(body);
    return savePayoutAccount(db, provider.id, payoutAccount);
  });

  app.put("/providers/me/push-token", async (request, reply) => {
    const provider = await requireAccount(request);

    if (!provider) {
      return reply.code(403).send({ message: "Account required." });
    }

    const body = pushTokenUpsertSchema.parse(request.body);
    await upsertPushDevice(db, provider.id, body);
    return { ok: true };
  });

  app.delete("/providers/me/push-token", async (request, reply) => {
    const provider = await requireAccount(request);

    if (!provider) {
      return reply.code(403).send({ message: "Account required." });
    }

    const body = pushTokenDeleteSchema.parse(request.body);
    await deletePushDevice(db, provider.id, body.token);
    return { ok: true };
  });

  app.get("/providers/me/notifications", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const rawLimit = (request.query as { limit?: string }).limit;
    const parsed = rawLimit ? Number(rawLimit) : 50;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;

    const notifications = await listProviderNotifications(db, provider.id, { limit });
    return { notifications };
  });

  app.post("/providers/me/notifications/:notificationId/read", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const notificationId = (request.params as { notificationId: string }).notificationId;
    const ok = await markProviderNotificationRead(db, provider.id, notificationId);

    if (!ok) {
      return reply.code(404).send({ message: "Not found." });
    }

    return { ok: true };
  });

  app.get("/companies", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    return { companies: await listCompanies(db, provider.id) };
  });

  app.post("/companies", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const body = companyProfileSchema.parse(request.body);
    return reply.code(201).send(await createCompany(db, provider.id, body));
  });

  app.put("/companies/:companyId", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const companyId = (request.params as { companyId: string }).companyId;
    const body = companyProfileSchema.parse(request.body);
    const company = await updateCompany(db, provider.id, companyId, body);

    if (!company) {
      return reply.code(404).send({ message: "Company not found." });
    }

    return company;
  });

  app.post("/companies/:companyId/logo", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const companyId = (request.params as { companyId: string }).companyId;
    const existingCompany = await getCompanyById(db, companyId);

    if (!existingCompany || existingCompany.providerId !== provider.id) {
      return reply.code(404).send({ message: "Company not found." });
    }

    const file = await request.file();

    if (!file) {
      return reply.code(400).send({ message: "Logo file is required." });
    }

    try {
      const logoUrl = await logoUploader({
        providerId: provider.id,
        companyId,
        file: {
          buffer: await file.toBuffer(),
          filename: file.filename,
          mimetype: file.mimetype,
        },
      });
      const company = await updateCompanyLogo(db, provider.id, companyId, logoUrl);

      if (!company) {
        return reply.code(404).send({ message: "Company not found." });
      }

      return company;
    } catch (error) {
      if (error instanceof LogoUploadValidationError) {
        return reply.code(400).send({ message: error.message });
      }

      if (error instanceof LogoUploadConfigError) {
        return reply.code(503).send({ message: "Logo uploads are not configured." });
      }

      throw error;
    }
  });

  app.get("/payout-banks", async (request, reply) => {
    const provider = await requireAccount(request);

    if (!provider) {
      return reply.code(403).send({ message: "Account required." });
    }

    return { banks: await listPaystackBanks() };
  });

  app.post("/payout-accounts/resolve", async (request, reply) => {
    const provider = await requireAccount(request);

    if (!provider) {
      return reply.code(403).send({ message: "Account required." });
    }

    const body = payoutAccountResolveSchema.parse(request.body);
    return resolvePaystackBankAccount(body);
  });

  app.get("/payout-accounts", async (request, reply) => {
    const provider = await requireAccount(request);

    if (!provider) {
      return reply.code(403).send({ message: "Account required." });
    }

    return { payoutAccounts: await listPayoutAccounts(db, provider.id) };
  });

  app.post("/payout-accounts", async (request, reply) => {
    const provider = await requireAccount(request);

    if (!provider) {
      return reply.code(403).send({ message: "Account required." });
    }

    const body = payoutSchema.parse(request.body);
    const payoutAccount = await verifyPayoutAccount(body);
    return reply.code(201).send(await createPayoutAccount(db, provider.id, payoutAccount));
  });

  app.post("/payout-accounts/:payoutAccountId/default", async (request, reply) => {
    const provider = await requireAccount(request);

    if (!provider) {
      return reply.code(403).send({ message: "Account required." });
    }

    const payoutAccountId = (request.params as { payoutAccountId: string }).payoutAccountId;
    const payoutAccount = await setDefaultPayoutAccount(db, provider.id, payoutAccountId);

    if (!payoutAccount) {
      return reply.code(404).send({ message: "Payout account not found." });
    }

    return payoutAccount;
  });

  app.get("/quotes", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const query = request.query as {
      filter?: string;
      limit?: string;
      offset?: string;
      search?: string;
      serviceLine?: string;
    };
    const filter = ["all", "unpaid", "viewed", "drafts"].includes(query.filter ?? "")
      ? (query.filter as "all" | "unpaid" | "viewed" | "drafts")
      : "all";
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const offset = Math.max(Number(query.offset) || 0, 0);

    if (query.filter || query.limit || query.offset) {
      return listQuotePage(db, provider.id, {
        filter,
        limit,
        offset,
        search: query.search,
        serviceLine: query.serviceLine,
      });
    }

    return { quotes: await listQuotes(db, provider.id) };
  });

  app.post("/quotes", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const body = createQuoteSchema.parse(request.body);
    const quote = await createQuote(db, provider.id, body).catch((error: unknown) => {
      if (error instanceof AiQuoteGenerationError) {
        return error;
      }
      throw error;
    });

    if (quote instanceof AiQuoteGenerationError) {
      request.log.error({ err: quote }, "AI quote generation failed");
      return reply.code(503).send({
        message: "AI quote generation failed. Please try again.",
      });
    }

    if (!quote) {
      return reply.code(400).send({ message: "Invalid company." });
    }

    return reply.code(201).send(quote);
  });

  app.get("/quotes/:quoteId", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const quoteId = (request.params as { quoteId: string }).quoteId;
    const quote = await getProviderQuote(db, provider.id, quoteId);

    if (!quote) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return quote;
  });

  app.get("/quotes/:quoteId/detail", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const quoteId = (request.params as { quoteId: string }).quoteId;
    const detail = await getProviderQuoteDetail(db, provider.id, quoteId);

    if (!detail) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return detail;
  });

  app.patch("/quotes/:quoteId", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const quoteId = (request.params as { quoteId: string }).quoteId;
    const body = updateQuoteSchema.parse(request.body);
    const quote = await updateQuote(db, provider.id, quoteId, body).catch((error: unknown) => {
      if (error instanceof AiQuoteGenerationError) {
        return error;
      }
      throw error;
    });

    if (quote instanceof AiQuoteGenerationError) {
      request.log.error({ err: quote }, "AI quote generation failed");
      return reply.code(503).send({
        message: "AI quote generation failed. Please try again.",
      });
    }

    if (!quote) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return quote;
  });

  app.post("/quotes/:quoteId/archive", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const quoteId = (request.params as { quoteId: string }).quoteId;
    const quote = await archiveQuote(db, provider.id, quoteId);

    if (!quote) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return quote;
  });

  app.post("/quotes/:quoteId/edit-draft", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const quoteId = (request.params as { quoteId: string }).quoteId;
    const quote = await getOrCreateQuoteEditDraft(db, provider.id, quoteId);

    if (!quote) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return quote;
  });

  app.delete("/quotes/:quoteId", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const quoteId = (request.params as { quoteId: string }).quoteId;
    const deleted = await deleteQuote(db, provider.id, quoteId);

    if (!deleted) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return reply.code(204).send();
  });

  app.post("/quotes/:quoteId/send", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const quoteId = (request.params as { quoteId: string }).quoteId;
    const body = sendQuoteSchema.parse(request.body);
    const bundle = await recordQuoteSend(db, provider.id, quoteId, body);

    if (!bundle) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return bundle;
  });

  app.get("/dashboard", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    return getDashboard(db, provider.id);
  });

  app.get("/earnings", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    return getEarnings(db, provider.id);
  });

  app.get("/public/quotes/:quoteId", async (request, reply) => {
    const quoteId = (request.params as { quoteId: string }).quoteId;
    const bundle = await getPublicQuoteBundle(db, quoteId);

    if (!bundle) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return bundle;
  });

  app.post("/public/quotes/:quoteId/view", async (request, reply) => {
    const quoteId = (request.params as { quoteId: string }).quoteId;
    const result = await recordPublicView(db, quoteId);

    if (!result) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    await maybeDispatchPush(result.pushTarget);
    return result.bundle;
  });

  app.post("/public/quotes/:quoteId/accept", async (request, reply) => {
    const quoteId = (request.params as { quoteId: string }).quoteId;
    const result = await recordPublicAccept(db, quoteId);

    if (!result) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    await maybeDispatchPush(result.pushTarget);
    return result.bundle;
  });

  app.post("/payments/initialize", async (request, reply) => {
    const body = initializePaymentSchema.parse(request.body);
    const bundle = await getPublicQuoteBundle(db, body.publicSlug);

    if (!bundle) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    if (!bundle.quote.collectDeposit || bundle.quote.depositAmount <= 0) {
      return reply.code(400).send({ message: "This quote does not require a deposit payment." });
    }

    if (["partial", "paid", "expired"].includes(bundle.quote.status)) {
      return reply.code(409).send({ message: "This quote is no longer accepting deposit payments." });
    }

    const amount = bundle.quote.depositAmount;
    const quoteId = bundle.quote.id;

    const result = await initializePayment({
      email: body.email,
      amount,
      quoteId,
      publicSlug: body.publicSlug,
      channel: body.channel,
      callbackUrl: `${env.APP_PUBLIC_URL}/q/${bundle.quote.publicSlug}/receipt`,
    });

    await createInitializedPayment(db, {
      publicSlug: body.publicSlug,
      email: body.email,
      channel: body.channel,
      amount,
      reference: result.reference,
    });

    if (result.mode === "mock") {
      const transitionResult = await applyPaymentTransition(db, {
        reference: result.reference,
        status: "paid",
        eventLabel: "Mock deposit paid",
        rawPayload: { event: "mock.charge.success", data: { reference: result.reference } },
      });

      await maybeDispatchPush(transitionResult?.pushTarget);
    }

    return result;
  });

  app.get("/payments/:reference/status", async (request, reply) => {
    const reference = (request.params as { reference: string }).reference;
    const publicSlug = (request.query as { publicSlug?: string }).publicSlug;

    if (!publicSlug) {
      return reply.code(400).send({ message: "publicSlug is required." });
    }

    const payment = await verifyPendingPayment({ publicSlug, reference });

    if (!payment) {
      return reply.code(404).send({ message: "Payment not found." });
    }

    return payment;
  });

  app.post("/payments/:reference/verify", async (request, reply) => {
    const reference = (request.params as { reference: string }).reference;
    const publicSlug = (request.body as { publicSlug?: string }).publicSlug;

    if (!publicSlug) {
      return reply.code(400).send({ message: "publicSlug is required." });
    }

    const payment = await verifyPendingPayment({ publicSlug, reference });

    if (!payment) {
      return reply.code(404).send({ message: "Payment not found." });
    }

    return payment;
  });

  app.post("/payments/paystack/webhook", async (request, reply) => {
    const rawBody = (request as RawBodyRequest).rawBody ?? JSON.stringify(request.body ?? {});
    const signature = request.headers["x-paystack-signature"];

    if (
      !verifyPaystackSignature(
        rawBody,
        Array.isArray(signature) ? signature[0] : signature,
        env.PAYSTACK_WEBHOOK_SECRET ?? env.PAYSTACK_SECRET_KEY,
      )
    ) {
      return reply.code(401).send({ ok: false });
    }

    const payload = request.body as { event?: string; data?: { reference?: string } };
    const transition = mapPaystackWebhookEvent(payload.event ?? "");

    if (transition.quoteEvent !== "ignored" && payload.data?.reference) {
      const transitionResult = await applyPaymentTransition(db, {
        reference: payload.data.reference,
        status: transition.paymentStatus,
        eventLabel: transition.label,
        rawPayload: payload,
      });

      await maybeDispatchPush(transitionResult?.pushTarget);
    }

    return {
      ok: true,
      reference: payload.data?.reference ?? null,
      transition,
    };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ message: "Invalid request.", issues: error.issues });
    }

    app.log.error(error);
    return reply.code(500).send({ message: "Internal server error." });
  });

  return app;
}
