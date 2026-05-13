import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import {
  GoogleAuthConfigError,
  GoogleAuthVerificationError,
  type GoogleProfile,
  verifyGoogleIdToken,
} from "../src/auth/google.js";
import type { Database } from "../src/db/pool.js";

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

    if (normalized.startsWith("select id::text from providers where google_sub")) {
      const sub = params[0] as string;
      const provider = [...this.providers.values()].find((row) => row.google_sub === sub);
      return { rows: provider ? [{ id: provider.id }] : [] };
    }

    if (normalized.startsWith("select id::text from providers where lower(google_email)")) {
      const email = (params[0] as string).toLowerCase();
      const provider = [...this.providers.values()].find(
        (row) => (row.google_email ?? "").toLowerCase() === email,
      );
      return { rows: provider ? [{ id: provider.id }] : [] };
    }

    if (
      normalized.startsWith("select id::text from providers where id =") &&
      normalized.includes("google_sub is null")
    ) {
      const id = params[0] as string;
      const provider = this.providers.get(id);
      return { rows: provider && provider.google_sub === null ? [{ id }] : [] };
    }

    if (normalized.startsWith("update providers set google_sub")) {
      const id = params[0] as string;
      const sub = params[1] as string;
      const email = params[2] as string;
      const picture = (params[3] as string | null) ?? null;
      const incomingName = (params[4] as string | undefined) ?? "";
      const provider = this.providers.get(id);
      if (!provider) return { rows: [] };
      provider.google_sub = sub;
      provider.google_email = email;
      provider.google_picture_url = picture ?? provider.google_picture_url;
      if (provider.business_name === "" && incomingName !== "") {
        provider.business_name = incomingName;
      }
      return { rows: [] };
    }

    if (normalized.startsWith("insert into providers (business_name, google_sub")) {
      const id = `provider-${this.nextId++}`;
      const provider: ProviderRow = {
        id,
        business_name: (params[0] as string) ?? "",
        service_line: "",
        customer_phone: "",
        account_phone: null,
        phone_verified_at: null,
        pin_hash: null,
        pin_set_at: null,
        has_logo: false,
        google_sub: params[1] as string,
        google_email: params[2] as string,
        google_picture_url: (params[3] as string | null) ?? null,
      };
      this.providers.set(id, provider);
      return { rows: [{ id }] };
    }

    if (normalized.startsWith("insert into providers default values")) {
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
      };
      this.providers.set(id, provider);
      return { rows: [{ id }] };
    }

    if (normalized.startsWith("insert into provider_sessions")) {
      this.sessions.set(params[1] as string, params[0] as string);
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

    throw new Error(`Unhandled fake query: ${normalized}`);
  }

  private providerResult(provider: ProviderRow) {
    return {
      ...provider,
      payout_bank_name: null,
      account_number_last4: null,
    };
  }
}

const sampleProfile: GoogleProfile = {
  sub: "google-12345",
  email: "ada@example.com",
  emailVerified: true,
  name: "Ada Lovelace",
  pictureUrl: "https://example.com/p.png",
};

describe("/auth/google", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function buildTestApp(
    db: FakeDb,
    verifier: (idToken: string) => Promise<GoogleProfile>,
  ) {
    const app = buildApp(db as unknown as Database, {
      googleIdTokenVerifier: verifier,
      otpSender: vi.fn(async () => undefined),
    });
    apps.add(app);
    return app;
  }

  it("creates a provider on first Google sign-in", async () => {
    const db = new FakeDb();
    const app = buildTestApp(db, async () => sampleProfile);

    const response = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "valid-id-token" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      token: expect.any(String),
      provider: {
        businessName: "Ada Lovelace",
        googleEmail: "ada@example.com",
        googlePictureUrl: "https://example.com/p.png",
        hasAccount: true,
      },
    });
    expect(db.providers.size).toBe(1);
    expect(db.sessions.size).toBe(1);
  });

  it("returns the same provider when signing in again with the same Google sub", async () => {
    const db = new FakeDb();
    const app = buildTestApp(db, async () => sampleProfile);

    const first = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "valid-token-1" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "valid-token-2" },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().provider.id).toBe(second.json().provider.id);
    expect(db.providers.size).toBe(1);
    expect(db.sessions.size).toBe(2);
  });

  it("links Google to an existing draft session when no account matches the Google identity", async () => {
    const db = new FakeDb();
    const app = buildTestApp(db, async () => sampleProfile);

    const session = await app.inject({
      method: "POST",
      url: "/auth/session",
      payload: { channel: "demo" },
    });
    const draftToken = session.json().token as string;
    const draftId = session.json().provider.id as string;

    const linked = await app.inject({
      method: "POST",
      url: "/auth/google",
      headers: { authorization: `Bearer ${draftToken}` },
      payload: { idToken: "valid-id-token" },
    });

    expect(linked.statusCode).toBe(201);
    expect(linked.json().provider.id).toBe(draftId);
    expect(db.providers.size).toBe(1);
  });

  it("returns 401 when the verifier rejects the token", async () => {
    const db = new FakeDb();
    const app = buildTestApp(db, async () => {
      throw new GoogleAuthVerificationError("invalid signature");
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "tampered-token" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ message: "invalid signature" });
    expect(db.providers.size).toBe(0);
  });

  it("returns 503 when Google sign-in is not configured", async () => {
    const db = new FakeDb();
    const app = buildTestApp(db, async () => {
      throw new GoogleAuthConfigError("missing GOOGLE_OAUTH_CLIENT_IDS");
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "valid-id-token" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().message).toContain("not configured");
  });

  it("validates that an idToken is supplied", async () => {
    const db = new FakeDb();
    const app = buildTestApp(db, async () => sampleProfile);

    const response = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("verifyGoogleIdToken", () => {
  function makeTicket(payload: Record<string, unknown> | null) {
    return {
      verifyIdToken: vi.fn(async () => ({
        getPayload: () => payload,
      })),
    };
  }

  it("throws a config error when no client IDs are configured", async () => {
    const error = await verifyGoogleIdToken("token", {
      clientIds: [],
      client: makeTicket(null) as unknown as Parameters<typeof verifyGoogleIdToken>[1] extends infer Opts ? Opts extends { client?: infer C } ? C : never : never,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(GoogleAuthConfigError);
  });

  it("throws when no token is supplied", async () => {
    const error = await verifyGoogleIdToken("", {
      clientIds: ["client-id"],
      client: makeTicket(null) as never,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(GoogleAuthVerificationError);
  });

  it("wraps verification errors thrown by the OAuth client", async () => {
    const client = {
      verifyIdToken: vi.fn(async () => {
        throw new Error("kaboom");
      }),
    };
    const error = await verifyGoogleIdToken("tok", {
      clientIds: ["client-id"],
      client: client as never,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(GoogleAuthVerificationError);
    expect((error as GoogleAuthVerificationError).message).toBe("kaboom");
  });

  it("wraps non-Error rejections thrown by the OAuth client", async () => {
    const client = {
      verifyIdToken: vi.fn(async () => {
        throw "kaboom";
      }),
    };
    const error = await verifyGoogleIdToken("tok", {
      clientIds: ["client-id"],
      client: client as never,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(GoogleAuthVerificationError);
    expect((error as GoogleAuthVerificationError).message).toBe(
      "Failed to verify Google ID token.",
    );
  });

  it("rejects tokens with no payload", async () => {
    const error = await verifyGoogleIdToken("tok", {
      clientIds: ["client-id"],
      client: makeTicket(null) as never,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(GoogleAuthVerificationError);
  });

  it("rejects tokens missing the subject claim", async () => {
    const error = await verifyGoogleIdToken("tok", {
      clientIds: ["client-id"],
      client: makeTicket({ email: "a@b.com", email_verified: true }) as never,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(GoogleAuthVerificationError);
    expect((error as GoogleAuthVerificationError).message).toMatch(/subject/);
  });

  it("rejects tokens missing the email claim", async () => {
    const error = await verifyGoogleIdToken("tok", {
      clientIds: ["client-id"],
      client: makeTicket({ sub: "123", email_verified: true }) as never,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(GoogleAuthVerificationError);
    expect((error as GoogleAuthVerificationError).message).toMatch(/email/);
  });

  it("rejects tokens with an unverified email", async () => {
    const error = await verifyGoogleIdToken("tok", {
      clientIds: ["client-id"],
      client: makeTicket({
        sub: "123",
        email: "a@b.com",
        email_verified: false,
      }) as never,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(GoogleAuthVerificationError);
    expect((error as GoogleAuthVerificationError).message).toMatch(/not verified/);
  });

  it("returns the mapped profile, lowercasing the email and including the picture", async () => {
    const profile = await verifyGoogleIdToken("tok", {
      clientIds: ["client-id"],
      client: makeTicket({
        sub: "google-1",
        email: "ADA@Example.COM",
        email_verified: true,
        name: "  Ada  ",
        picture: "https://example.com/pic.png",
      }) as never,
    });

    expect(profile).toEqual({
      sub: "google-1",
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada",
      pictureUrl: "https://example.com/pic.png",
    });
  });

  it("falls back to given_name when name is missing and works without a picture", async () => {
    const profile = await verifyGoogleIdToken("tok", {
      clientIds: ["client-id"],
      client: makeTicket({
        sub: "google-2",
        email: "g@x.com",
        email_verified: true,
        given_name: "Grace",
      }) as never,
    });

    expect(profile.name).toBe("Grace");
    expect(profile.pictureUrl).toBeUndefined();
  });

  it("returns an empty name when neither name nor given_name is present", async () => {
    const profile = await verifyGoogleIdToken("tok", {
      clientIds: ["client-id"],
      client: makeTicket({
        sub: "google-3",
        email: "x@y.com",
        email_verified: true,
      }) as never,
    });

    expect(profile.name).toBe("");
  });
});
