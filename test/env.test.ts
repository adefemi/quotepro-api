import { afterEach, describe, expect, it, vi } from "vitest";

describe("env config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses false boolean strings as false", async () => {
    vi.resetModules();
    vi.stubEnv("MOCK_PAYMENTS", "false");

    const { env } = await import("../src/config/env.js");

    expect(env.MOCK_PAYMENTS).toBe(false);
  });

  it("parses true boolean strings as true", async () => {
    vi.resetModules();
    vi.stubEnv("MOCK_PAYMENTS", "true");

    const { env } = await import("../src/config/env.js");

    expect(env.MOCK_PAYMENTS).toBe(true);
  });

  it("splits GOOGLE_OAUTH_CLIENT_IDS into a trimmed list", async () => {
    vi.resetModules();
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_IDS", " ios.client , web.client , ");

    const { googleOAuthClientIds } = await import("../src/config/env.js");

    expect(googleOAuthClientIds).toEqual(["ios.client", "web.client"]);
  });

  it("returns an empty array when GOOGLE_OAUTH_CLIENT_IDS is unset", async () => {
    vi.resetModules();
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_IDS", "");

    const { googleOAuthClientIds } = await import("../src/config/env.js");

    expect(googleOAuthClientIds).toEqual([]);
  });

  it("defaults the WhatsApp template fields when not configured", async () => {
    vi.resetModules();
    vi.stubEnv("WHATSAPP_OTP_TEMPLATE_NAME", "");
    vi.stubEnv("WHATSAPP_OTP_TEMPLATE_LANGUAGE", "");
    vi.stubEnv("WHATSAPP_API_VERSION", "");
    vi.stubEnv("WHATSAPP_API_BASE_URL", "");

    const { env } = await import("../src/config/env.js");

    expect(env.WHATSAPP_OTP_TEMPLATE_NAME).toBe("otp_code");
    expect(env.WHATSAPP_OTP_TEMPLATE_LANGUAGE).toBe("en");
    expect(env.WHATSAPP_API_VERSION).toBe("v22.0");
    expect(env.WHATSAPP_API_BASE_URL).toBe("https://graph.facebook.com");
    expect(env.EXPOSE_OTP_CODE).toBe(false);
  });
});
