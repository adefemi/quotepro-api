import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../src/db/pool.js";

async function makeApp(
  db: Database,
  options: { paystackSecretKey?: string; paystackWebhookSecret?: string } = {},
) {
  vi.resetModules();
  process.env.MOCK_PAYMENTS = "true";
  process.env.OPENAI_API_KEY = "";
  process.env.PAYSTACK_SECRET_KEY = options.paystackSecretKey ?? "";
  process.env.PAYSTACK_WEBHOOK_SECRET = options.paystackWebhookSecret ?? "";
  const { buildApp } = await import("../src/app.js");
  return buildApp(db);
}

type QuoteRow = {
  id: string;
  quote_number: string;
  public_slug: string;
  provider_id: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_location: string;
  job_title: string;
  description: string;
  prompt: string;
  subtotal_amount: number;
  vat_amount: number;
  total_amount: number;
  deposit_amount: number;
  collect_deposit: boolean;
  valid_until: Date;
  status: string;
  company_id: string | null;
};

type PaymentRow = {
  quote_id: string;
  paystack_reference: string;
  email: string;
  channel: string;
  amount: number;
  purpose: "deposit" | "balance";
  status: string;
  paid_at: Date | null;
  raw_payload: unknown;
};

type ProviderRow = {
  id: string;
  business_name: string;
  service_line: string;
  customer_phone: string;
  account_phone: string | null;
  phone_verified_at: Date | null;
  pin_set_at: Date | null;
  has_logo: boolean;
};

type QuoteEventRow = {
  id: string;
  quote_id: string;
  kind: string;
  label: string;
  occurred_at: Date;
};

class PaymentRoutesFakeDb {
  quotes = new Map<string, QuoteRow>();
  payments = new Map<string, PaymentRow>();
  providers = new Map<string, ProviderRow>();
  quoteEvents: QuoteEventRow[] = [];
  notifications: Array<{ id: string }> = [];
  feedback: Array<{ quote_id: string; provider_id: string; type: string; message: string; rating: number | null }> = [];
  private nextId = 1;

  seedDepositQuote(input: Partial<QuoteRow> & Pick<QuoteRow, "public_slug" | "quote_number">) {
    const id = input.id ?? `quote-${this.nextId++}`;
    const row: QuoteRow = {
      id,
      provider_id: input.provider_id ?? "provider-1",
      customer_id: input.customer_id ?? null,
      customer_name: input.customer_name ?? "Ada",
      customer_phone: input.customer_phone ?? "",
      customer_location: input.customer_location ?? "",
      job_title: input.job_title ?? "Job",
      description: input.description ?? "Desc",
      prompt: input.prompt ?? "",
      subtotal_amount: input.subtotal_amount ?? 100000,
      vat_amount: input.vat_amount ?? 7500,
      total_amount: input.total_amount ?? 107500,
      deposit_amount: input.deposit_amount ?? 50000,
      collect_deposit: input.collect_deposit ?? true,
      valid_until: input.valid_until ?? new Date(),
      status: input.status ?? "accepted",
      company_id: input.company_id ?? null,
      ...input,
    };
    this.quotes.set(row.id, row);
    return row;
  }

  seedProvider(id = "provider-1") {
    const row: ProviderRow = {
      id,
      business_name: "Tolu Plumbing",
      service_line: "Plumbing",
      customer_phone: "",
      account_phone: null,
      phone_verified_at: null,
      pin_set_at: null,
      has_logo: false,
    };
    this.providers.set(id, row);
    return row;
  }

  async connect() {
    return {
      query: this.query.bind(this),
      release: () => undefined,
    };
  }

  async query(sql: string, params: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized === "begin" || normalized === "commit" || normalized === "rollback") {
      return { rows: [] };
    }

    if (normalized.startsWith("select * from quotes")) {
      const lookup = (params[0] as string).toLowerCase();
      const quote = [...this.quotes.values()].find(
        (row) =>
          row.public_slug.toLowerCase() === lookup ||
          row.quote_number.toLowerCase() === lookup ||
          row.id === params[0],
      );
      return { rows: quote ? [quote as unknown as Record<string, unknown>] : [] };
    }

    if (normalized.includes("from quote_items")) {
      return { rows: [] };
    }

    if (normalized.includes("from quote_events qe") && normalized.includes("join quotes q")) {
      const quoteId = params[0] as string;
      return {
        rows: this.quoteEvents
          .filter((event) => event.quote_id === quoteId)
          .map((event) => {
            const quote = this.quotes.get(event.quote_id)!;
            return {
              id: event.id,
              quote_number: quote.quote_number,
              kind: event.kind,
              label: event.label,
              occurred_at: event.occurred_at,
            };
          }),
      };
    }

    if (normalized.includes("from quote_client_feedback qcf")) {
      return {
        rows: this.feedback
          .filter((row) => row.quote_id === params[0])
          .map((row, index) => {
            const quote = this.quotes.get(row.quote_id)!;
            return {
              id: `feedback-${index + 1}`,
              quote_number: quote.quote_number,
              type: row.type,
              message: row.message,
              rating: row.rating,
              created_at: new Date(),
            };
          }),
      };
    }

    if (normalized.includes("from providers p") && normalized.includes("where p.id = $1")) {
      const provider = this.providers.get(params[0] as string);
      return {
        rows: provider
          ? [
              {
                ...provider,
                payout_bank_name: null,
                account_number_last4: null,
              },
            ]
          : [],
      };
    }

    if (normalized.startsWith("insert into payments")) {
      const payment: PaymentRow = {
        quote_id: params[0] as string,
        paystack_reference: params[1] as string,
        email: params[2] as string,
        channel: params[3] as string,
        amount: params[4] as number,
        purpose: (params[5] as "deposit" | "balance") ?? "deposit",
        status: "initialized",
        paid_at: null,
        raw_payload: null,
      };
      this.payments.set(payment.paystack_reference, payment);
      return { rows: [] };
    }

    if (normalized.startsWith("select p.id::text, q.quote_number, p.amount, p.paystack_reference, p.status")) {
      const reference = params[0] as string;
      const publicSlug = (params[1] as string).toLowerCase();
      const payment = this.payments.get(reference);
      const quote = payment ? this.quotes.get(payment.quote_id) : undefined;

      if (!payment || !quote || quote.public_slug.toLowerCase() !== publicSlug || quote.status === "archived") {
        return { rows: [] };
      }

      return {
        rows: [
          {
            id: `payment-${reference}`,
            quote_number: quote.quote_number,
            amount: payment.amount,
            paystack_reference: payment.paystack_reference,
            status: payment.status,
            purpose: payment.purpose,
          },
        ],
      };
    }

    if (normalized.startsWith("update payments set status = $2")) {
      const payment = this.payments.get(params[0] as string);
      if (!payment) return { rows: [] };
      payment.status = params[1] as string;
      payment.raw_payload = params[2];
      if (payment.status === "paid") payment.paid_at = payment.paid_at ?? new Date();
      return { rows: [payment as unknown as Record<string, unknown>] };
    }

    if (normalized.includes("select provider_id::text, customer_name, quote_number from quotes where id")) {
      const quote = this.quotes.get(params[0] as string) ?? [...this.quotes.values()].find((q) => q.id === params[0]);
      if (!quote) return { rows: [] };
      return {
        rows: [
          {
            provider_id: quote.provider_id,
            customer_name: quote.customer_name,
            quote_number: quote.quote_number,
          },
        ],
      };
    }

    if (normalized.startsWith("update quotes set status = $2")) {
      const quote = [...this.quotes.values()].find((q) => q.id === params[0]);
      if (quote) {
        quote.status = params[1] as string;
      }
      return { rows: [] };
    }

    if (normalized.startsWith("update quotes set status = case when status in")) {
      const quote = [...this.quotes.values()].find((q) => q.id === params[0]);
      if (quote && ["draft", "sent"].includes(quote.status)) {
        quote.status = "viewed";
      }
      return { rows: [] };
    }

    if (normalized.startsWith("insert into quote_client_feedback")) {
      this.feedback.push({
        quote_id: params[0] as string,
        provider_id: params[1] as string,
        type: params[2] as string,
        message: params[3] as string,
        rating: params[4] as number | null,
      });
      return { rows: [] };
    }

    if (normalized.startsWith("insert into quote_events")) {
      const quoteId = params[0] as string;
      const label = params[1] as string;
      let kind = "unknown";
      if (typeof params[1] === "string" && typeof params[2] === "string") {
        kind = params[1] as string;
      } else if (normalized.includes("'viewed'")) {
        kind = "viewed";
      } else if (normalized.includes("'accepted'")) {
        kind = "accepted";
      } else if (normalized.includes("'deposit_paid'")) {
        kind = "deposit_paid";
      } else if (normalized.includes("'balance_paid'")) {
        kind = "balance_paid";
      } else if (normalized.includes("'revision_requested'")) {
        kind = "revision_requested";
      } else if (normalized.includes("'review_received'")) {
        kind = "review_received";
      } else if (normalized.includes("'payment_failed'")) {
        kind = "payment_failed";
      }
      this.quoteEvents.push({
        id: `evt-${this.nextId++}`,
        quote_id: quoteId,
        kind,
        label: (params[2] as string | undefined) ?? label ?? "event",
        occurred_at: new Date(),
      });
      return { rows: [] };
    }

    if (normalized.startsWith("insert into provider_notifications")) {
      const id = `notif-${this.nextId++}`;
      this.notifications.push({ id });
      return { rows: [{ id }] };
    }

    if (normalized.includes("fcm_token from provider_push_devices")) {
      return { rows: [] };
    }

    throw new Error(`Unhandled fake query: ${normalized}`);
  }
}

describe("payments HTTP routes", () => {
  const apps = new Set<{ close: () => Promise<void> }>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  it("initializes a mock payment using the quote deposit amount from the bundle", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    const quote = fake.seedDepositQuote({
      public_slug: "PUB-SLUG-1",
      quote_number: "Q-PAY-1",
      deposit_amount: 99_000,
    });

    const app = await makeApp(fake as unknown as Database);
    apps.add(app);

    const response = await app.inject({
      method: "POST",
      url: "/payments/initialize",
      payload: {
        email: "buyer@example.com",
        channel: "card",
        publicSlug: "PUB-SLUG-1",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { mode: string; reference: string; authorizationUrl: string };
    expect(body.mode).toBe("mock");
    expect(body.reference).toBe("mock_q-pay-1");
    expect(body.authorizationUrl).toContain("reference=mock_q-pay-1");

    const stored = fake.payments.get("mock_q-pay-1");
    expect(stored).toMatchObject({
      quote_id: quote.id,
      email: "buyer@example.com",
      channel: "card",
      amount: 99_000,
      status: "paid",
    });
    expect(quote.status).toBe("partial");
  });

  it("initializes a mock balance payment and marks the quote paid", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    const quote = fake.seedDepositQuote({
      public_slug: "PUB-BALANCE-1",
      quote_number: "Q-BAL-1",
      status: "partial",
      total_amount: 120_000,
      deposit_amount: 50_000,
    });

    const app = await makeApp(fake as unknown as Database);
    apps.add(app);

    const response = await app.inject({
      method: "POST",
      url: "/payments/initialize",
      payload: {
        email: "buyer@example.com",
        channel: "card",
        publicSlug: "PUB-BALANCE-1",
        purpose: "balance",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { reference: string };
    const stored = fake.payments.get(body.reference);
    expect(stored).toMatchObject({
      quote_id: quote.id,
      amount: 70_000,
      purpose: "balance",
      status: "paid",
    });
    expect(quote.status).toBe("paid");
    expect(fake.quoteEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quote_id: quote.id, kind: "balance_paid" }),
      ]),
    );
  });

  it("rejects initialization when the quote does not collect a deposit", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    fake.seedDepositQuote({
      public_slug: "NO-DEP",
      quote_number: "Q-NODEP",
      collect_deposit: false,
      deposit_amount: 0,
    });

    const app = await makeApp(fake as unknown as Database);
    apps.add(app);

    const response = await app.inject({
      method: "POST",
      url: "/payments/initialize",
      payload: {
        email: "buyer@example.com",
        channel: "bank_transfer",
        publicSlug: "NO-DEP",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: "This quote does not require a deposit payment.",
    });
  });

  it("rejects initialization for quotes that already have a completed or expired payment state", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    fake.seedDepositQuote({
      public_slug: "ALREADY-PAID",
      quote_number: "Q-PAID",
      status: "partial",
    });

    const app = await makeApp(fake as unknown as Database);
    apps.add(app);

    const response = await app.inject({
      method: "POST",
      url: "/payments/initialize",
      payload: {
        email: "buyer@example.com",
        channel: "card",
        publicSlug: "ALREADY-PAID",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      message: "This quote is no longer accepting deposit payments.",
    });
  });

  it("returns payment status only when the reference belongs to the public quote", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    const quote = fake.seedDepositQuote({
      public_slug: "STATUS-SLUG",
      quote_number: "Q-STATUS",
    });
    fake.payments.set("ref_paid", {
      quote_id: quote.id,
      paystack_reference: "ref_paid",
      email: "buyer@example.com",
      channel: "card",
      amount: 50_000,
      purpose: "deposit",
      status: "paid",
      paid_at: new Date(),
      raw_payload: null,
    });

    const app = await makeApp(fake as unknown as Database);
    apps.add(app);

    const ok = await app.inject({
      method: "GET",
      url: "/payments/ref_paid/status?publicSlug=STATUS-SLUG",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      quoteId: "Q-STATUS",
      reference: "ref_paid",
      amount: 50_000,
      status: "paid",
    });

    const wrongQuote = await app.inject({
      method: "GET",
      url: "/payments/ref_paid/status?publicSlug=OTHER-SLUG",
    });
    expect(wrongQuote.statusCode).toBe(404);
  });

  it("verifies initialized payments when the status endpoint is polled", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    const quote = fake.seedDepositQuote({
      public_slug: "POLL-SLUG",
      quote_number: "Q-POLL",
    });
    fake.payments.set("ref_poll", {
      quote_id: quote.id,
      paystack_reference: "ref_poll",
      email: "buyer@example.com",
      channel: "card",
      amount: 50_000,
      purpose: "deposit",
      status: "initialized",
      paid_at: null,
      raw_payload: null,
    });

    const app = await makeApp(fake as unknown as Database);
    apps.add(app);

    const response = await app.inject({
      method: "GET",
      url: "/payments/ref_poll/status?publicSlug=POLL-SLUG",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      quoteId: "Q-POLL",
      reference: "ref_poll",
      status: "paid",
    });
    expect(fake.payments.get("ref_poll")?.status).toBe("paid");
    expect(quote.status).toBe("partial");
  });

  it("verifies an initialized payment and applies the confirmed transition", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    const quote = fake.seedDepositQuote({
      public_slug: "VERIFY-SLUG",
      quote_number: "Q-VERIFY",
    });
    fake.payments.set("ref_verify", {
      quote_id: quote.id,
      paystack_reference: "ref_verify",
      email: "buyer@example.com",
      channel: "card",
      amount: 50_000,
      purpose: "deposit",
      status: "initialized",
      paid_at: null,
      raw_payload: null,
    });

    const app = await makeApp(fake as unknown as Database);
    apps.add(app);

    const response = await app.inject({
      method: "POST",
      url: "/payments/ref_verify/verify",
      payload: {
        publicSlug: "VERIFY-SLUG",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      quoteId: "Q-VERIFY",
      reference: "ref_verify",
      status: "paid",
    });
    expect(fake.payments.get("ref_verify")?.status).toBe("paid");
    expect(quote.status).toBe("partial");
  });

  it("applies charge.success and charge.failed webhook transitions", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    const quote = fake.seedDepositQuote({
      public_slug: "WEB-SLUG",
      quote_number: "Q-WEB",
    });

    const app = await makeApp(fake as unknown as Database);
    apps.add(app);

    const init = await app.inject({
      method: "POST",
      url: "/payments/initialize",
      payload: {
        email: "buyer@example.com",
        channel: "ussd",
        publicSlug: "WEB-SLUG",
      },
    });
    const ref = (init.json() as { reference: string }).reference;

    const success = await app.inject({
      method: "POST",
      url: "/payments/paystack/webhook",
      payload: {
        event: "charge.success",
        data: { reference: ref },
      },
    });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toMatchObject({
      ok: true,
      reference: ref,
      transition: { quoteEvent: "deposit_paid" },
    });
    expect(fake.payments.get(ref)?.status).toBe("paid");
    expect(quote.status).toBe("partial");

    const failedQuote = fake.seedDepositQuote({
      public_slug: "FAIL-SLUG",
      quote_number: "Q-FAIL",
    });
    fake.payments.set("ref_failed", {
      quote_id: failedQuote.id,
      paystack_reference: "ref_failed",
      email: "buyer2@example.com",
      channel: "card",
      amount: 50_000,
      purpose: "deposit",
      status: "initialized",
      paid_at: null,
      raw_payload: null,
    });

    const failed = await app.inject({
      method: "POST",
      url: "/payments/paystack/webhook",
      payload: {
        event: "charge.failed",
        data: { reference: "ref_failed" },
      },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({
      ok: true,
      reference: "ref_failed",
      transition: { quoteEvent: "payment_failed" },
    });
    expect(fake.payments.get("ref_failed")?.status).toBe("failed");
  });

  it("rejects webhooks with an invalid Paystack signature when a secret is configured", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    fake.seedDepositQuote({
      public_slug: "SIG-SLUG",
      quote_number: "Q-SIG",
    });

    const app = await makeApp(fake as unknown as Database, {
      paystackSecretKey: "sk_live_test",
      paystackWebhookSecret: "whsec_test",
    });
    apps.add(app);

    const body = JSON.stringify({ event: "charge.success", data: { reference: "mock_q-sig" } });
    const goodSig = createHmac("sha512", "whsec_test").update(body).digest("hex");

    const ok = await app.inject({
      method: "POST",
      url: "/payments/paystack/webhook",
      headers: { "Content-Type": "application/json", "x-paystack-signature": goodSig },
      payload: body,
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: "POST",
      url: "/payments/paystack/webhook",
      headers: { "Content-Type": "application/json", "x-paystack-signature": "deadbeef" },
      payload: body,
    });
    expect(bad.statusCode).toBe(401);
  });

  it("records a public quote view once for noisy refreshes", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    const quote = fake.seedDepositQuote({
      public_slug: "VIEW-SLUG",
      quote_number: "Q-VIEW",
      status: "sent",
    });

    const app = await makeApp(fake as unknown as Database);
    apps.add(app);

    const first = await app.inject({ method: "POST", url: "/public/quotes/VIEW-SLUG/view" });
    const second = await app.inject({ method: "POST", url: "/public/quotes/VIEW-SLUG/view" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(quote.status).toBe("viewed");
    expect(fake.quoteEvents.filter((event) => event.kind === "viewed")).toHaveLength(1);
    expect(fake.notifications).toHaveLength(1);
  });

  it("stores revision requests and reviews as events and notifications", async () => {
    const fake = new PaymentRoutesFakeDb();
    fake.seedProvider();
    const quote = fake.seedDepositQuote({
      public_slug: "FEEDBACK-SLUG",
      quote_number: "Q-FEEDBACK",
      status: "partial",
    });

    const app = await makeApp(fake as unknown as Database);
    apps.add(app);

    const revision = await app.inject({
      method: "POST",
      url: "/public/quotes/FEEDBACK-SLUG/revision-requests",
      payload: { message: "Please add the extra sink repair." },
    });
    const review = await app.inject({
      method: "POST",
      url: "/public/quotes/FEEDBACK-SLUG/reviews",
      payload: { rating: 5, message: "Great job and clean finish." },
    });

    expect(revision.statusCode).toBe(200);
    expect(review.statusCode).toBe(200);
    expect(fake.feedback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quote_id: quote.id, type: "revision_request" }),
        expect.objectContaining({ quote_id: quote.id, type: "review", rating: 5 }),
      ]),
    );
    expect(fake.quoteEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "revision_requested" }),
        expect.objectContaining({ kind: "review_received" }),
      ]),
    );
    expect(fake.notifications).toHaveLength(2);
  });
});
