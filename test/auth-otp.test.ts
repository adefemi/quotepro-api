import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { Database } from "../src/db/pool.js";
import { WhatsAppConfigError, WhatsAppDeliveryError } from "../src/notifications/whatsapp.js";

type ProviderRow = {
  id: string;
  business_name: string;
  service_line: string;
  customer_phone: string;
  account_phone: string | null;
  phone_verified_at: Date | null;
  pin_hash: string | null;
  pin_set_at: Date | null;
  has_logo: boolean;
  google_sub: string | null;
  google_email: string | null;
  google_picture_url: string | null;
};

class FakeDb {
  providers = new Map<string, ProviderRow>();
  sessions = new Map<string, string>();
  otps = new Map<string, { code: string; expires_at: Date }>();
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

    if (normalized.startsWith("insert into providers default values")) {
      const provider = this.createProvider();
      return { rows: [{ id: provider.id }] };
    }

    if (normalized.startsWith("insert into providers (account_phone")) {
      const phone = params[0] as string;
      const provider = this.createProvider({
        account_phone: phone,
        customer_phone: phone,
        phone_verified_at: new Date(),
      });
      return { rows: [{ id: provider.id }] };
    }

    if (normalized.startsWith("insert into provider_sessions")) {
      this.sessions.set(params[1] as string, params[0] as string);
      return { rows: [] };
    }

    if (normalized.startsWith("insert into phone_otps")) {
      this.otps.set(params[0] as string, {
        code: params[1] as string,
        expires_at: params[2] as Date,
      });
      return { rows: [] };
    }

    if (normalized.startsWith("select code, expires_at from phone_otps")) {
      const otp = this.otps.get(params[0] as string);
      return { rows: otp ? [otp] : [] };
    }

    if (
      normalized.startsWith("select id::text from providers where account_phone") &&
      normalized.includes("pin_hash = crypt")
    ) {
      const phone = params[0] as string;
      const pin = params[1] as string;
      const provider = [...this.providers.values()].find(
        (row) => row.account_phone === phone && row.phone_verified_at && row.pin_hash === pin,
      );
      return { rows: provider ? [{ id: provider.id }] : [] };
    }

    if (normalized.startsWith("select id::text from providers where account_phone")) {
      const phone = params[0] as string;
      const provider = [...this.providers.values()].find((row) => row.account_phone === phone);
      return { rows: provider ? [{ id: provider.id }] : [] };
    }

    if (normalized.startsWith("update providers set pin_hash")) {
      const id = params[0] as string;
      const pin = params[1] as string;
      const provider = this.providers.get(id);
      if (!provider?.phone_verified_at) return { rows: [] };
      provider.pin_hash = pin;
      provider.pin_set_at = new Date();
      return { rows: [{ id }] };
    }

    if (normalized.startsWith("update providers set account_phone")) {
      const id = params[0] as string;
      const phone = params[1] as string;
      const provider = this.providers.get(id);
      if (!provider) return { rows: [] };
      provider.account_phone = phone;
      provider.phone_verified_at = new Date();
      if (!provider.customer_phone) provider.customer_phone = phone;
      return { rows: [{ id }] };
    }

    if (normalized.startsWith("delete from phone_otps")) {
      this.otps.delete(params[0] as string);
      return { rows: [] };
    }

    if (normalized.includes("from provider_sessions s join providers")) {
      const providerId = this.sessions.get(params[0] as string);
      const provider = providerId ? this.providers.get(providerId) : undefined;
      return { rows: provider ? [this.providerResult(provider)] : [] };
    }

    if (normalized.includes("from providers p") && normalized.includes("where p.id = $1")) {
      const provider = this.providers.get(params[0] as string);
      return { rows: provider ? [this.providerResult(provider)] : [] };
    }

    if (normalized.startsWith("update quotes") || normalized.startsWith("update customers")) {
      return { rows: [] };
    }

    throw new Error(`Unhandled fake query: ${normalized}`);
  }

  private createProvider(input: Partial<ProviderRow> = {}) {
    const id = `provider-${this.nextId++}`;
    const provider: ProviderRow = {
      id,
      business_name: "",
      service_line: "",
      customer_phone: "",
      account_phone: null,
      phone_verified_at: null,
      pin_hash: null,
      pin_set_at: null,
      has_logo: false,
      google_sub: null,
      google_email: null,
      google_picture_url: null,
      ...input,
    };
    this.providers.set(id, provider);
    return provider;
  }

  private providerResult(provider: ProviderRow) {
    return {
      ...provider,
      payout_bank_name: null,
      account_number_last4: null,
    };
  }
}

describe("phone OTP auth", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function buildTestApp(db: FakeDb, sender = vi.fn(async () => undefined)) {
    const app = buildApp(db as unknown as Database, {
      otpSender: sender,
      exposeOtpCode: true,
    });
    apps.add(app);
    return { app, sender };
  }

  it("starts OTP, sends it via WhatsApp, and verifies a new phone account", async () => {
    const sender = vi.fn(async () => undefined);
    const { app } = buildTestApp(new FakeDb(), sender);

    const start = await app.inject({
      method: "POST",
      url: "/auth/otp/start",
      payload: { phone: "+2348032214490" },
    });
    expect(start.statusCode).toBe(201);
    const startBody = start.json();
    expect(startBody).toMatchObject({
      phone: "+2348032214490",
      channel: "whatsapp",
      delivered: true,
    });
    expect(startBody.code).toMatch(/^\d{6}$/);
    expect(sender).toHaveBeenCalledWith({
      phone: "+2348032214490",
      code: startBody.code,
    });

    const verify = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { phone: "+2348032214490", code: startBody.code },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({
      token: expect.any(String),
      provider: {
        hasAccount: true,
        hasPin: false,
        accountPhone: "+2348032214490",
      },
    });
  });

  it("rejects OTP codes that do not match what was sent", async () => {
    const { app } = buildTestApp(new FakeDb());

    const start = await app.inject({
      method: "POST",
      url: "/auth/otp/start",
      payload: { phone: "+2348032214490" },
    });
    const sentCode = start.json().code as string;
    const wrongCode = sentCode === "000000" ? "111111" : "000000";

    const verify = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { phone: "+2348032214490", code: wrongCode },
    });
    expect(verify.statusCode).toBe(400);
    expect(verify.json()).toMatchObject({ message: "Invalid or expired OTP." });
  });

  it("attaches OTP verification to an existing draft session", async () => {
    const { app } = buildTestApp(new FakeDb());

    const session = await app.inject({
      method: "POST",
      url: "/auth/session",
      payload: { channel: "demo" },
    });
    const token = session.json().token as string;

    const start = await app.inject({
      method: "POST",
      url: "/auth/otp/start",
      payload: { phone: "+2348032214490" },
    });
    const verify = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      headers: { authorization: `Bearer ${token}` },
      payload: { phone: "+2348032214490", code: start.json().code as string },
    });

    expect(verify.statusCode).toBe(200);
    expect(verify.json().provider).toMatchObject({
      id: session.json().provider.id,
      hasAccount: true,
      hasPin: false,
      accountPhone: "+2348032214490",
    });
  });

  it("sets a PIN after OTP signup and logs in with that PIN", async () => {
    const { app } = buildTestApp(new FakeDb());

    const start = await app.inject({
      method: "POST",
      url: "/auth/otp/start",
      payload: { phone: "+2348032214490" },
    });
    const verify = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { phone: "+2348032214490", code: start.json().code as string },
    });
    const signupToken = verify.json().token as string;

    const setPin = await app.inject({
      method: "PUT",
      url: "/providers/me/pin",
      headers: { authorization: `Bearer ${signupToken}` },
      payload: { pin: "2468" },
    });
    expect(setPin.statusCode).toBe(200);
    expect(setPin.json()).toMatchObject({
      hasAccount: true,
      hasPin: true,
      accountPhone: "+2348032214490",
    });

    const login = await app.inject({
      method: "POST",
      url: "/auth/login/pin",
      payload: { phone: "+2348032214490", pin: "2468" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      token: expect.any(String),
      provider: {
        hasAccount: true,
        hasPin: true,
        accountPhone: "+2348032214490",
      },
    });
  });

  it("rejects an invalid PIN without creating another provider", async () => {
    const db = new FakeDb();
    const { app } = buildTestApp(db);

    const start = await app.inject({
      method: "POST",
      url: "/auth/otp/start",
      payload: { phone: "+2348032214490" },
    });
    const verify = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { phone: "+2348032214490", code: start.json().code as string },
    });
    await app.inject({
      method: "PUT",
      url: "/providers/me/pin",
      headers: { authorization: `Bearer ${verify.json().token}` },
      payload: { pin: "2468" },
    });

    const providersBeforeLogin = db.providers.size;
    const login = await app.inject({
      method: "POST",
      url: "/auth/login/pin",
      payload: { phone: "+2348032214490", pin: "1357" },
    });

    expect(login.statusCode).toBe(401);
    expect(db.providers.size).toBe(providersBeforeLogin);
  });

  it("does not create a provider when PIN login uses an unknown phone", async () => {
    const db = new FakeDb();
    const { app } = buildTestApp(db);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login/pin",
      payload: { phone: "+2348000000000", pin: "2468" },
    });

    expect(login.statusCode).toBe(401);
    expect(db.providers.size).toBe(0);
  });

  it("returns 503 when WhatsApp delivery fails", async () => {
    const sender = vi.fn(async () => {
      throw new WhatsAppDeliveryError("upstream 500", 500, "boom");
    });
    const app = buildApp(new FakeDb() as unknown as Database, {
      otpSender: sender,
      exposeOtpCode: true,
    });
    apps.add(app);

    const start = await app.inject({
      method: "POST",
      url: "/auth/otp/start",
      payload: { phone: "+2348032214490" },
    });

    expect(start.statusCode).toBe(503);
    expect(start.json()).toMatchObject({
      message: expect.stringContaining("WhatsApp"),
    });
  });

  it("propagates WhatsApp config errors as 503 when codes are not exposed", async () => {
    const sender = vi.fn(async () => {
      throw new WhatsAppConfigError("missing access token");
    });
    const app = buildApp(new FakeDb() as unknown as Database, {
      otpSender: sender,
      exposeOtpCode: false,
    });
    apps.add(app);

    const start = await app.inject({
      method: "POST",
      url: "/auth/otp/start",
      payload: { phone: "+2348032214490" },
    });

    expect(start.statusCode).toBe(503);
  });

  it("still stores the OTP when the sender is unconfigured but codes are exposed (dev mode)", async () => {
    const sender = vi.fn(async () => {
      throw new WhatsAppConfigError("missing access token");
    });
    const db = new FakeDb();
    const app = buildApp(db as unknown as Database, {
      otpSender: sender,
      exposeOtpCode: true,
    });
    apps.add(app);

    const start = await app.inject({
      method: "POST",
      url: "/auth/otp/start",
      payload: { phone: "+2348032214490" },
    });

    expect(start.statusCode).toBe(201);
    expect(start.json()).toMatchObject({
      phone: "+2348032214490",
      delivered: false,
    });
    expect(db.otps.size).toBe(1);
  });
});
