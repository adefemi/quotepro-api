import { describe, expect, it } from "vitest";

import { pushTokenDeleteSchema, pushTokenUpsertSchema } from "../src/domain.js";

describe("notification schemas", () => {
  it("parses push token upsert", () => {
    const parsed = pushTokenUpsertSchema.parse({
      token: "fcm-token",
      platform: "android",
      appVersion: "1.0.0",
    });
    expect(parsed.platform).toBe("android");
    expect(parsed.appVersion).toBe("1.0.0");
  });

  it("parses push token delete", () => {
    const parsed = pushTokenDeleteSchema.parse({ token: "fcm-token" });
    expect(parsed.token).toBe("fcm-token");
  });
});
