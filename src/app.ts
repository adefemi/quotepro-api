import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { corsOrigins, env } from "./config/env.js";
import type { Database } from "./db/pool.js";
import {
  companyProfileSchema,
  createQuoteSchema,
  initializePaymentSchema,
  otpStartSchema,
  otpVerifySchema,
  pinLoginSchema,
  pinSchema,
  payoutSchema,
  providerProfileSchema,
  sendQuoteSchema,
  signInSchema,
  updateQuoteSchema,
} from "./domain.js";
import {
  applyPaymentTransition,
  createCompany,
  createInitializedPayment,
  createPayoutAccount,
  createQuote,
  createSession,
  getDashboard,
  getEarnings,
  getCompanyById,
  loginWithPin,
  listCompanies,
  listPayoutAccounts,
  getProviderByToken,
  getProviderQuote,
  getProviderQuoteDetail,
  getPublicQuoteBundle,
  listQuotes,
  recordPublicAccept,
  recordPublicView,
  recordQuoteSend,
  savePayoutAccount,
  saveProviderPin,
  setDefaultPayoutAccount,
  startPhoneOtp,
  updateCompany,
  updateCompanyLogo,
  updateProviderProfile,
  updateQuote,
  verifyPhoneOtp,
} from "./repository.js";
import { initializePayment, mapPaystackWebhookEvent, verifyPaystackSignature } from "./payments/paystack.js";
import {
  type CompanyLogoFile,
  LogoUploadConfigError,
  LogoUploadValidationError,
  uploadCompanyLogoToS3,
} from "./storage/company-logos.js";

type RawBodyRequest = FastifyRequest & { rawBody?: string };
type LogoUploader = (input: { providerId: string; companyId: string; file: CompanyLogoFile }) => Promise<string>;

function getBearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  return header.slice("Bearer ".length).trim();
}

export function buildApp(db: Database, options: { logoUploader?: LogoUploader } = {}) {
  const app = Fastify({
    logger: true,
  });
  const logoUploader = options.logoUploader ?? uploadCompanyLogoToS3;

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
    return reply.code(201).send(await startPhoneOtp(db, body));
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
    return savePayoutAccount(db, provider.id, body);
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
    return reply.code(201).send(await createPayoutAccount(db, provider.id, body));
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

    return { quotes: await listQuotes(db, provider.id) };
  });

  app.post("/quotes", async (request, reply) => {
    const provider = await requireProvider(request);

    if (!provider) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const body = createQuoteSchema.parse(request.body);
    const quote = await createQuote(db, provider.id, body);

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
    const quote = await updateQuote(db, provider.id, quoteId, body);

    if (!quote) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return quote;
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
    const bundle = await recordPublicView(db, quoteId);

    if (!bundle) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return bundle;
  });

  app.post("/public/quotes/:quoteId/accept", async (request, reply) => {
    const quoteId = (request.params as { quoteId: string }).quoteId;
    const bundle = await recordPublicAccept(db, quoteId);

    if (!bundle) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    return bundle;
  });

  app.post("/payments/initialize", async (request, reply) => {
    const body = initializePaymentSchema.parse(request.body);
    const bundle = await getPublicQuoteBundle(db, body.publicSlug);

    if (!bundle) {
      return reply.code(404).send({ message: "Quote not found." });
    }

    const result = await initializePayment({
      email: body.email,
      amount: body.amount,
      quoteId: body.quoteId ?? bundle.quote.id,
      publicSlug: body.publicSlug,
      channel: body.channel,
      callbackUrl: `${env.APP_PUBLIC_URL}/q/${bundle.quote.publicSlug}/receipt`,
    });

    await createInitializedPayment(db, {
      publicSlug: body.publicSlug,
      email: body.email,
      channel: body.channel,
      amount: body.amount,
      reference: result.reference,
    });

    return result;
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
      await applyPaymentTransition(db, {
        reference: payload.data.reference,
        status: transition.paymentStatus,
        eventLabel: transition.label,
        rawPayload: payload,
      });
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
