import { describe, expect, it } from "vitest";

import type { Database } from "../src/db/pool.js";
import {
  applyPaymentTransition,
  archiveQuote,
  createCompany,
  createInitializedPayment,
  createPayoutAccount,
  createQuote,
  deleteQuote,
  getDashboard,
  getEarnings,
  getOrCreateQuoteEditDraft,
  getPublicQuoteBundle,
  listCompanies,
  listQuotePage,
  listQuotes,
  recordPublicAccept,
  recordPublicView,
  recordQuoteSend,
  setDefaultPayoutAccount,
  updateCompany,
  updateCompanyLogo,
} from "../src/repository.js";

type CompanyRow = {
  id: string;
  provider_id: string;
  business_name: string;
  service_line: string;
  customer_phone: string;
  logo_url: string | null;
  is_default: boolean;
  created_at: Date;
};

type PayoutRow = {
  id: string;
  provider_id: string;
  bank_name: string;
  bank_code: string | null;
  account_number_last4: string;
  account_name: string | null;
  paystack_recipient_code: string | null;
  is_default: boolean;
  created_at: Date;
};

type QuoteRow = {
  id: string;
  quote_number: string;
  public_slug: string;
  source_quote_id: string | null;
  provider_id: string;
  customer_id: string;
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
  sent_at?: Date;
  accepted_at?: Date;
  paid_at?: Date;
};

type QuoteEventRow = {
  id: string;
  quote_id: string;
  kind: string;
  label: string;
  occurred_at: Date;
};

type PaymentRow = {
  quote_id: string;
  paystack_reference: string;
  email: string;
  channel: string;
  amount: number;
  status: string;
  paid_at: Date | null;
  raw_payload: unknown;
};

class FakeDb {
  companies = new Map<string, CompanyRow>();
  payouts = new Map<string, PayoutRow>();
  quotes = new Map<string, QuoteRow>();
  events: QuoteEventRow[] = [];
  payments = new Map<string, PaymentRow>();
  quoteItems: Array<{
    id: string;
    quote_id: string;
    title: string;
    quantity_label: string;
    unit_amount: number;
    total_amount: number;
    sort_order: number;
  }> = [];
  private nextId = 1;

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

    if (normalized.startsWith("select 1 from provider_companies where provider_id")) {
      const providerId = params[0] as string;
      const exists = [...this.companies.values()].some((company) => company.provider_id === providerId);
      return { rows: exists ? [{ "?column?": 1 }] : [] };
    }

    if (normalized.startsWith("insert into provider_companies")) {
      const company = this.createCompany({
        provider_id: params[0] as string,
        business_name: params[1] as string,
        service_line: params[2] as string,
        customer_phone: params[3] as string,
        logo_url: (params[4] as string | null) ?? null,
        is_default: params[5] as boolean,
      });
      return { rows: [company] };
    }

    if (normalized.includes("from provider_companies") && normalized.includes("where provider_id = $1")) {
      const providerId = params[0] as string;
      const rows = [...this.companies.values()]
        .filter((company) => company.provider_id === providerId)
        .sort((left, right) => Number(right.is_default) - Number(left.is_default));
      return { rows };
    }

    if (normalized.includes("from provider_companies") && normalized.includes("where id = $1")) {
      const company = this.companies.get(params[0] as string);
      return { rows: company ? [company] : [] };
    }

    if (normalized.startsWith("update provider_companies") && normalized.includes("set logo_url = $3")) {
      const company = this.companies.get(params[0] as string);
      if (!company || company.provider_id !== params[1]) return { rows: [] };
      company.logo_url = params[2] as string;
      return { rows: [company] };
    }

    if (normalized.startsWith("update provider_companies")) {
      const company = this.companies.get(params[0] as string);
      if (!company || company.provider_id !== params[1]) return { rows: [] };
      company.business_name = params[2] as string;
      company.service_line = params[3] as string;
      company.customer_phone = params[4] as string;
      company.logo_url = (params[5] as string | null) ?? null;
      return { rows: [company] };
    }

    if (normalized.startsWith("select 1 from payout_accounts where provider_id")) {
      const providerId = params[0] as string;
      const exists = [...this.payouts.values()].some((account) => account.provider_id === providerId);
      return { rows: exists ? [{ "?column?": 1 }] : [] };
    }

    if (normalized.startsWith("update payout_accounts set is_default = false where provider_id")) {
      for (const account of this.payouts.values()) {
        if (account.provider_id === params[0]) account.is_default = false;
      }
      return { rows: [] };
    }

    if (normalized.startsWith("insert into payout_accounts")) {
      const account = this.createPayout({
        provider_id: params[0] as string,
        bank_name: params[1] as string,
        bank_code: (params[2] as string | null) ?? null,
        account_number_last4: params[3] as string,
        account_name: (params[4] as string | null) ?? null,
        paystack_recipient_code: (params[5] as string | null) ?? null,
        is_default: params[6] as boolean,
      });
      return { rows: [account] };
    }

    if (normalized.startsWith("select id::text from payout_accounts where id = $1")) {
      const account = this.payouts.get(params[0] as string);
      return { rows: account && account.provider_id === params[1] ? [{ id: account.id }] : [] };
    }

    if (normalized.startsWith("update payout_accounts set is_default = true")) {
      const account = this.payouts.get(params[0] as string);
      if (!account) return { rows: [] };
      account.is_default = true;
      return { rows: [account] };
    }

    if (normalized.startsWith("insert into customers")) {
      return { rows: [{ id: `customer-${this.nextId++}` }] };
    }

    if (normalized.startsWith("insert into quotes")) {
      const hasSource = normalized.includes("source_quote_id");
      const quote = this.createQuote(
        hasSource
          ? {
              quote_number: params[0] as string,
              public_slug: params[1] as string,
              source_quote_id: params[2] as string,
              provider_id: params[3] as string,
              customer_id: params[4] as string,
              customer_name: params[5] as string,
              customer_phone: params[6] as string,
              customer_location: params[7] as string,
              job_title: params[8] as string,
              description: params[9] as string,
              prompt: params[10] as string,
              subtotal_amount: params[11] as number,
              vat_amount: params[12] as number,
              total_amount: params[13] as number,
              deposit_amount: params[14] as number,
              collect_deposit: params[15] as boolean,
              valid_until: params[16] as Date,
              company_id: params[17] as string,
            }
          : {
              quote_number: params[0] as string,
              public_slug: params[1] as string,
              source_quote_id: null,
              provider_id: params[2] as string,
              customer_id: params[3] as string,
              customer_name: params[4] as string,
              customer_phone: params[5] as string,
              customer_location: params[6] as string,
              job_title: params[7] as string,
              description: params[8] as string,
              prompt: params[9] as string,
              subtotal_amount: params[10] as number,
              vat_amount: params[11] as number,
              total_amount: params[12] as number,
              deposit_amount: params[13] as number,
              collect_deposit: params[14] as boolean,
              valid_until: params[15] as Date,
              company_id: params[16] as string,
            },
      );
      return { rows: [quote] };
    }

    if (normalized.startsWith("insert into quote_items")) {
      this.quoteItems.push({
        id: `item-${this.nextId++}`,
        quote_id: params[0] as string,
        title: params[1] as string,
        quantity_label: params[2] as string,
        unit_amount: params[3] as number,
        total_amount: params[4] as number,
        sort_order: params[5] as number,
      });
      return { rows: [] };
    }

    if (normalized.startsWith("delete from quote_items where quote_id")) {
      const quoteId = params[0] as string;
      this.quoteItems = this.quoteItems.filter((item) => item.quote_id !== quoteId);
      return { rows: [] };
    }

    if (normalized.startsWith("insert into send_attempts")) {
      return { rows: [] };
    }

    if (normalized.includes("select provider_id::text, customer_name, quote_number from quotes where id")) {
      const quote = this.quotes.get(params[0] as string);
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

    if (normalized.startsWith("update quotes set status = case when status = 'draft' then 'sent'")) {
      const quote = this.quotes.get(params[0] as string);
      if (quote) {
        quote.status = quote.status === "draft" ? "sent" : quote.status;
        quote.sent_at = quote.sent_at ?? new Date();
      }
      return { rows: [] };
    }

    if (normalized.startsWith("update quotes set status = 'archived'")) {
      const quote = this.quotes.get(params[0] as string);
      if (!quote) return { rows: [] };
      quote.status = "archived";
      return { rows: [quote] };
    }

    if (normalized.startsWith("update quotes set job_title")) {
      const quote = this.quotes.get(params[0] as string);
      if (!quote) return { rows: [] };
      quote.job_title = params[1] as string;
      quote.description = params[2] as string;
      quote.subtotal_amount = params[3] as number;
      quote.vat_amount = params[4] as number;
      quote.total_amount = params[5] as number;
      quote.collect_deposit = params[6] as boolean;
      quote.deposit_amount = params[7] as number;
      quote.status = params[8] as string;
      return { rows: [quote] };
    }

    if (normalized.startsWith("update quotes set customer_name")) {
      const quote = this.quotes.get(params[0] as string);
      if (!quote) return { rows: [] };
      quote.customer_name = params[1] as string;
      quote.customer_phone = params[2] as string;
      quote.customer_location = params[3] as string;
      quote.job_title = params[4] as string;
      quote.description = params[5] as string;
      quote.prompt = params[6] as string;
      quote.subtotal_amount = params[7] as number;
      quote.vat_amount = params[8] as number;
      quote.total_amount = params[9] as number;
      quote.collect_deposit = params[10] as boolean;
      quote.deposit_amount = params[11] as number;
      quote.status = params[12] as string;
      return { rows: [quote] };
    }

    if (normalized.startsWith("update quotes set status = case when status in ('draft', 'sent') then 'viewed'")) {
      const quote = this.quotes.get(params[0] as string);
      if (quote && ["draft", "sent"].includes(quote.status)) quote.status = "viewed";
      return { rows: [] };
    }

    if (normalized.startsWith("update quotes set status = 'accepted'")) {
      const quote = this.quotes.get(params[0] as string);
      if (quote) {
        quote.status = "accepted";
        quote.accepted_at = quote.accepted_at ?? new Date();
      }
      return { rows: [] };
    }

    if (normalized.startsWith("update quotes") && normalized.includes("set status = 'partial'")) {
      const quote = this.quotes.get(params[0] as string);
      if (quote) {
        quote.status = "partial";
        quote.paid_at = quote.paid_at ?? new Date();
      }
      return { rows: [] };
    }

    if (normalized.startsWith("update quotes set status = $2")) {
      const quote = this.quotes.get(params[0] as string);
      if (quote) {
        quote.status = params[1] as string;
        quote.paid_at = quote.paid_at ?? new Date();
      }
      return { rows: [] };
    }

    if (normalized.startsWith("insert into provider_notifications")) {
      return { rows: [{ id: `notif-${this.nextId++}` }] };
    }

    if (normalized.startsWith("insert into quote_events")) {
      const knownKinds = ["sent", "viewed", "accepted", "deposit_paid", "payment_failed", "drafted", "archived"];
      const kind = knownKinds.find((value) => normalized.includes(`'${value}'`)) ?? (params[1] as string);
      const label =
        kind === "sent" || kind === "deposit_paid" || kind === "payment_failed"
          ? (params[1] as string)
          : kind === "viewed"
            ? "Quote viewed"
            : kind === "accepted"
              ? "Customer accepted quote"
              : kind === "drafted"
                ? "Quote drafted"
                : kind === "archived"
                  ? "Quote archived"
                  : (params[2] as string);
      this.events.push({
        id: `event-${this.nextId++}`,
        quote_id: params[0] as string,
        kind,
        label,
        occurred_at: new Date(),
      });
      return { rows: [] };
    }

    if (normalized.includes("from quote_items")) {
      const quoteId = params[0] as string;
      return {
        rows: this.quoteItems
          .filter((item) => item.quote_id === quoteId)
          .sort((left, right) => left.sort_order - right.sort_order),
      };
    }

    if (normalized.startsWith("select distinct pc.service_line")) {
      const providerId = params[0] as string;
      const serviceLines = new Set<string>();
      for (const company of this.companies.values()) {
        const hasQuote = [...this.quotes.values()].some(
          (quote) =>
            quote.provider_id === providerId &&
            quote.company_id === company.id &&
            quote.status !== "archived",
        );
        if (company.provider_id === providerId && company.service_line && hasQuote) {
          serviceLines.add(company.service_line);
        }
      }
      return {
        rows: [...serviceLines].sort().map((service_line) => ({ service_line })),
      };
    }

    if (normalized.startsWith("select count(*)::int as total from quotes q")) {
      const rows = this.filteredQuoteRows(normalized, params);
      return { rows: [{ total: rows.length }] };
    }

    if (normalized.startsWith("select q.* from quotes q")) {
      const limit = params.at(-2) as number;
      const offset = params.at(-1) as number;
      return {
        rows: this.filteredQuoteRows(normalized, params)
          .sort((left, right) => new Date(right.valid_until).getTime() - new Date(left.valid_until).getTime())
          .slice(offset, offset + limit),
      };
    }

    if (normalized.startsWith("select * from quotes where provider_id = $1")) {
      if (normalized.includes("source_quote_id = $2")) {
        const providerId = params[0] as string;
        const sourceQuoteId = params[1] as string;
        return {
          rows: [...this.quotes.values()]
            .filter(
              (quote) =>
                quote.provider_id === providerId &&
                quote.source_quote_id === sourceQuoteId &&
                quote.status === "draft",
            )
            .sort((left, right) => new Date(right.valid_until).getTime() - new Date(left.valid_until).getTime())
            .slice(0, 1),
        };
      }
      const providerId = params[0] as string;
      return {
        rows: [...this.quotes.values()]
          .filter((quote) => quote.provider_id === providerId && quote.status !== "archived")
          .sort((left, right) => new Date(right.valid_until).getTime() - new Date(left.valid_until).getTime()),
      };
    }

    if (normalized.startsWith("select count(*)::int as total from quotes where provider_id = $1")) {
      const providerId = params[0] as string;
      const rows = [...this.quotes.values()].filter((quote) => {
        if (quote.provider_id !== providerId || quote.status === "archived") return false;
        if (normalized.includes("status = 'viewed'")) return quote.status === "viewed";
        if (normalized.includes("status = 'draft'")) return quote.status === "draft";
        if (normalized.includes("status in ('sent', 'viewed', 'accepted', 'partial', 'expired')")) {
          return ["sent", "viewed", "accepted", "partial", "expired"].includes(quote.status);
        }
        return true;
      });
      return { rows: [{ total: rows.length }] };
    }

    if (normalized.startsWith("select coalesce(sum(case when status in")) {
      const quotes = [...this.quotes.values()].filter(
        (quote) => quote.provider_id === params[0] && quote.status !== "archived",
      );
      return {
        rows: [
          {
            paid_total: quotes
              .filter((quote) => ["partial", "paid"].includes(quote.status))
              .reduce((sum, quote) => sum + quote.total_amount, 0),
            quote_count: quotes.length,
            active_count: quotes.filter((quote) => ["sent", "viewed"].includes(quote.status)).length,
            accepted_count: quotes.filter((quote) => ["accepted", "partial", "paid"].includes(quote.status)).length,
          },
        ],
      };
    }

    if (normalized.startsWith("select coalesce(sum(p.amount)")) {
      const providerId = params[0] as string;
      const paid = [...this.payments.values()].filter((payment) => {
        const quote = this.quotes.get(payment.quote_id);
        return quote?.provider_id === providerId && quote.status !== "archived" && payment.status === "paid";
      });
      return {
        rows: [
          {
            paid_amount: paid.reduce((sum, payment) => sum + payment.amount, 0),
            paid_count: paid.length,
          },
        ],
      };
    }

    if (normalized.startsWith("select customer_name, coalesce(sum(total_amount)")) {
      const providerId = params[0] as string;
      const totals = new Map<string, number>();
      for (const quote of this.quotes.values()) {
        if (quote.provider_id !== providerId || quote.status === "archived" || !["partial", "paid"].includes(quote.status)) continue;
        totals.set(quote.customer_name, (totals.get(quote.customer_name) ?? 0) + quote.total_amount);
      }
      return {
        rows: [...totals.entries()].map(([customer_name, total_amount]) => ({ customer_name, total_amount })),
      };
    }

    if (normalized.startsWith("insert into payments")) {
      const payment: PaymentRow = {
        quote_id: params[0] as string,
        paystack_reference: params[1] as string,
        email: params[2] as string,
        channel: params[3] as string,
        amount: params[4] as number,
        status: "initialized",
        paid_at: null,
        raw_payload: null,
      };
      this.payments.set(payment.paystack_reference, payment);
      return { rows: [] };
    }

    if (normalized.startsWith("update payments set status = $2")) {
      const payment = this.payments.get(params[0] as string);
      if (!payment) return { rows: [] };
      payment.status = params[1] as string;
      payment.raw_payload = params[2];
      if (payment.status === "paid") payment.paid_at = payment.paid_at ?? new Date();
      return { rows: [payment] };
    }

    if (normalized.startsWith("delete from quotes where id = $1")) {
      const quoteId = params[0] as string;
      this.quotes.delete(quoteId);
      this.quoteItems = this.quoteItems.filter((item) => item.quote_id !== quoteId);
      this.events = this.events.filter((event) => event.quote_id !== quoteId);
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
      return { rows: quote ? [quote] : [] };
    }

    if (normalized.includes("from providers p") && normalized.includes("where p.id = $1")) {
      return {
        rows: [
          {
            id: params[0],
            business_name: "Provider Account",
            service_line: "Shared workspace",
            customer_phone: "",
            account_phone: "+2348032214490",
            phone_verified_at: new Date(),
            pin_set_at: new Date(),
            has_logo: false,
            payout_bank_name: null,
            account_number_last4: null,
          },
        ],
      };
    }

    if (normalized.includes("from quote_events")) {
      const quoteId = params[0] as string;
      return {
        rows: this.events
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
      return { rows: [] };
    }

    throw new Error(`Unhandled fake query: ${normalized}`);
  }

  private createCompany(input: Omit<CompanyRow, "id" | "created_at">) {
    const company = {
      id: `company-${this.nextId++}`,
      created_at: new Date(),
      ...input,
    };
    this.companies.set(company.id, company);
    return company;
  }

  private createPayout(input: Omit<PayoutRow, "id" | "created_at">) {
    const account = {
      id: `payout-${this.nextId++}`,
      created_at: new Date(),
      ...input,
    };
    this.payouts.set(account.id, account);
    return account;
  }

  private createQuote(input: Omit<QuoteRow, "id" | "status">) {
    const quote = {
      id: `quote-${this.nextId++}`,
      status: "draft",
      ...input,
    };
    this.quotes.set(quote.id, quote);
    return quote;
  }

  private filteredQuoteRows(normalizedSql: string, params: unknown[]) {
    const providerId = params[0] as string;
    const search = normalizedSql.includes("lower(q.job_title)") ? (params[1] as string).replaceAll("%", "") : "";
    const serviceLineParamIndex = normalizedSql.includes("pc.service_line")
      ? search
        ? 2
        : 1
      : -1;
    const serviceLine = serviceLineParamIndex > -1 ? (params[serviceLineParamIndex] as string) : "";

    return [...this.quotes.values()].filter((quote) => {
      if (quote.provider_id !== providerId || quote.status === "archived") return false;
      if (normalizedSql.includes("q.status = 'viewed'") && quote.status !== "viewed") return false;
      if (normalizedSql.includes("q.status = 'draft'") && quote.status !== "draft") return false;
      if (
        normalizedSql.includes("q.status in ('sent', 'viewed', 'accepted', 'partial', 'expired')") &&
        !["sent", "viewed", "accepted", "partial", "expired"].includes(quote.status)
      ) {
        return false;
      }
      if (
        search &&
        !`${quote.job_title} ${quote.customer_name} ${quote.description}`.toLowerCase().includes(search.toLowerCase())
      ) {
        return false;
      }
      if (serviceLine) {
        const company = quote.company_id ? this.companies.get(quote.company_id) : null;
        if (company?.service_line !== serviceLine) return false;
      }
      return true;
    });
  }
}

describe("company and payout profiles", () => {
  it("creates, lists, and authorizes company profile updates", async () => {
    const db = new FakeDb() as unknown as Database;
    const company = await createCompany(db, "provider-1", {
      businessName: "Tolu Plumbing",
      serviceLine: "Plumbing",
      customerPhone: "+2348000000000",
    });

    expect(company).toMatchObject({
      businessName: "Tolu Plumbing",
      isDefault: true,
    });
    expect(await listCompanies(db, "provider-1")).toHaveLength(1);

    const updated = await updateCompany(db, "provider-1", company.id, {
      businessName: "Tolu Electrical",
      serviceLine: "Electrical",
      customerPhone: "+2348111111111",
    });
    const forbidden = await updateCompany(db, "provider-2", company.id, {
      businessName: "Bad Update",
      serviceLine: "Bad",
      customerPhone: "",
    });

    expect(updated?.businessName).toBe("Tolu Electrical");
    expect(forbidden).toBeNull();
  });

  it("keeps one default payout account per provider", async () => {
    const db = new FakeDb() as unknown as Database;
    const first = await createPayoutAccount(db, "provider-1", {
      bankName: "GTBank",
      accountLast4: "2018",
      bankCode: "058",
      accountName: "ADE FEMI",
      paystackRecipientCode: "RCP_123",
    });
    const second = await createPayoutAccount(db, "provider-1", {
      bankName: "Access Bank",
      accountLast4: "4488",
    });

    expect(first.isDefault).toBe(true);
    expect(first.bankCode).toBe("058");
    expect(first.accountName).toBe("ADE FEMI");
    expect(second.isDefault).toBe(false);

    const selected = await setDefaultPayoutAccount(db, "provider-1", second.id);

    expect(selected?.id).toBe(second.id);
    expect([...((db as unknown as FakeDb).payouts.values())].filter((account) => account.is_default)).toHaveLength(1);
  });

  it("stores selected company branding on quotes and public quote bundles", async () => {
    const db = new FakeDb() as unknown as Database;
    const company = await createCompany(db, "provider-1", {
      businessName: "Tolu Electrical",
      serviceLine: "Electrical",
      customerPhone: "+2348111111111",
    });

    const quote = await createQuote(db, "provider-1", {
      companyId: company.id,
      customerName: "Ada",
      customerPhone: "+2348000000000",
      customerLocation: "Lagos",
      prompt: "Wire a new shop",
      collectDeposit: true,
    });

    expect(quote?.company).toMatchObject({
      id: company.id,
      businessName: "Tolu Electrical",
    });

    const bundle = await getPublicQuoteBundle(db, quote!.publicSlug);

    expect(bundle?.quote.company).toMatchObject({
      id: company.id,
      serviceLine: "Electrical",
    });
  });

  it("updates company logo only for the owning provider", async () => {
    const db = new FakeDb() as unknown as Database;
    const company = await createCompany(db, "provider-1", {
      businessName: "Tolu Electrical",
      serviceLine: "Electrical",
      customerPhone: "+2348111111111",
    });

    const forbidden = await updateCompanyLogo(db, "provider-2", company.id, "https://cdn.example.com/bad.png");
    const updated = await updateCompanyLogo(db, "provider-1", company.id, "https://cdn.example.com/logo.png");

    expect(forbidden).toBeNull();
    expect(updated?.logoUrl).toBe("https://cdn.example.com/logo.png");
  });

  it("pages quote templates by search and registered business offering", async () => {
    const db = new FakeDb() as unknown as Database;
    const plumbing = await createCompany(db, "provider-1", {
      businessName: "Tolu Plumbing",
      serviceLine: "Plumbing",
      customerPhone: "+2348000000000",
    });
    await createCompany(db, "provider-1", {
      businessName: "Tolu Catering",
      serviceLine: "Catering",
      customerPhone: "+2348000000000",
    });
    await createQuote(db, "provider-1", {
      companyId: plumbing.id,
      customerName: "Ada",
      customerPhone: "+2348000000000",
      customerLocation: "Lagos",
      prompt: "Sink repair",
      jobTitle: "Kitchen sink repair",
      description: "Repair a leaking kitchen sink",
      items: [{ title: "Labour", quantityLabel: "1 job", unitAmount: 15000, totalAmount: 15000 }],
      collectDeposit: true,
    });

    const page = await listQuotePage(db, "provider-1", {
      filter: "all",
      limit: 20,
      offset: 0,
      search: "sink",
      serviceLine: "Plumbing",
    });

    expect(page.total).toBe(1);
    expect(page.categories).toEqual(["Plumbing"]);
    expect(page.quotes[0]).toMatchObject({
      jobTitle: "Kitchen sink repair",
      company: { serviceLine: "Plumbing" },
    });
  });

  it("archives and deletes provider quotes", async () => {
    const db = new FakeDb() as unknown as Database;
    const first = await createQuote(db, "provider-1", {
      customerName: "Ada",
      customerPhone: "+2348000000000",
      customerLocation: "Lagos",
      prompt: "Fix a leaking sink",
      collectDeposit: true,
    });
    const second = await createQuote(db, "provider-1", {
      customerName: "Bola",
      customerPhone: "+2348111111111",
      customerLocation: "Abuja",
      prompt: "Install kitchen tap",
      collectDeposit: false,
    });

    expect(await listQuotes(db, "provider-1")).toHaveLength(2);
    const firstQuote = first!;
    const secondQuote = second!;

    const archived = await archiveQuote(db, "provider-1", firstQuote.id);

    expect(archived?.status).toBe("archived");
    expect(await listQuotes(db, "provider-1")).toHaveLength(1);
    expect(await getPublicQuoteBundle(db, firstQuote.publicSlug)).toBeNull();

    const forbiddenDelete = await deleteQuote(db, "provider-2", secondQuote.id);
    const deleted = await deleteQuote(db, "provider-1", secondQuote.id);

    expect(forbiddenDelete).toBe(false);
    expect(deleted).toBe(true);
    expect(await listQuotes(db, "provider-1")).toHaveLength(0);
  });

  it("reopens the existing quote for editing", async () => {
    const db = new FakeDb() as unknown as Database;
    const quote = await createQuote(db, "provider-1", {
      customerName: "Ada",
      customerPhone: "+2348000000000",
      customerLocation: "Lagos",
      prompt: "Fix bathroom piping",
      collectDeposit: true,
    });
    const sent = await recordQuoteSend(db, "provider-1", quote!.id, {
      channel: "whatsapp",
    });
    const createdQuote = quote!;

    expect(sent?.quote.status).toBe("sent");

    const firstEdit = await getOrCreateQuoteEditDraft(db, "provider-1", createdQuote.id);
    const secondEdit = await getOrCreateQuoteEditDraft(db, "provider-1", createdQuote.id);

    expect(firstEdit?.id).toBe(createdQuote.id);
    expect(firstEdit?.status).toBe("sent");
    expect(secondEdit?.id).toBe(firstEdit?.id);
    expect(await listQuotes(db, "provider-1")).toHaveLength(1);
  });

  it("smoke tests quote send, public activity, payment, dashboard, and earnings", async () => {
    const db = new FakeDb() as unknown as Database;
    const company = await createCompany(db, "provider-1", {
      businessName: "Tolu Plumbing",
      serviceLine: "Plumbing",
      customerPhone: "+2348111111111",
    });
    await createPayoutAccount(db, "provider-1", {
      bankName: "GTBank",
      accountLast4: "2018",
    });
    const quote = await createQuote(db, "provider-1", {
      companyId: company.id,
      customerName: "Ada",
      customerPhone: "+2348000000000",
      customerLocation: "Lagos",
      prompt: "Replace old copper with PPR piping in a bathroom",
      collectDeposit: true,
    });

    expect(quote).not.toBeNull();
    const createdQuote = quote!;

    const sent = await recordQuoteSend(db, "provider-1", createdQuote.id, {
      channel: "whatsapp",
      destination: "+2348000000000",
    });
    const viewed = await recordPublicView(db, createdQuote.publicSlug);
    const accepted = await recordPublicAccept(db, createdQuote.publicSlug);
    await createInitializedPayment(db, {
      publicSlug: createdQuote.publicSlug,
      email: "ada@example.com",
      channel: "card",
      amount: createdQuote.depositAmount,
      reference: "paystack-ref-1",
      purpose: "deposit",
    });
    await applyPaymentTransition(db, {
      reference: "paystack-ref-1",
      status: "paid",
      eventLabel: "Paystack charge.success",
      rawPayload: { event: "charge.success" },
    });

    const dashboard = await getDashboard(db, "provider-1");
    const earnings = await getEarnings(db, "provider-1");
    const publicBundle = await getPublicQuoteBundle(db, createdQuote.publicSlug);

    expect(sent?.quote.status).toBe("sent");
    expect(viewed?.bundle.quote.status).toBe("viewed");
    expect(accepted?.bundle.quote.status).toBe("accepted");
    expect(publicBundle?.quote.status).toBe("partial");
    expect(publicBundle?.timeline.map((event) => event.kind)).toEqual([
      "drafted",
      "sent",
      "viewed",
      "accepted",
      "deposit_paid",
    ]);
    expect(dashboard).toMatchObject({
      quoteCount: 1,
      acceptedCount: 1,
      activeCount: 0,
    });
    expect(earnings).toMatchObject({
      paidAmount: createdQuote.depositAmount,
      paidCount: 1,
    });
    expect(earnings.topCustomers).toEqual([
      { name: "Ada", amount: createdQuote.totalAmount },
    ]);
  });
});
