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
});
