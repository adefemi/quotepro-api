import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { mapPaystackWebhookEvent, verifyPaystackSignature } from "../src/payments/paystack.js";

describe("mapPaystackWebhookEvent", () => {
  it("maps successful charges to paid deposits", () => {
    expect(mapPaystackWebhookEvent("charge.success")).toMatchObject({
      paymentStatus: "paid",
      quoteEvent: "deposit_paid",
    });
  });

  it("ignores unsupported events", () => {
    expect(mapPaystackWebhookEvent("transfer.reversed")).toMatchObject({
      paymentStatus: "pending",
      quoteEvent: "ignored",
    });
  });

  it("maps failed charges to payment_failed", () => {
    expect(mapPaystackWebhookEvent("charge.failed")).toMatchObject({
      paymentStatus: "failed",
      quoteEvent: "payment_failed",
    });
  });
});

describe("verifyPaystackSignature", () => {
  it("verifies the HMAC signature when a secret is configured", () => {
    const body = JSON.stringify({ event: "charge.success" });
    const secret = "paystack_secret";
    const signature = createHmac("sha512", secret).update(body).digest("hex");

    expect(verifyPaystackSignature(body, signature, secret)).toBe(true);
    expect(verifyPaystackSignature(body, "bad", secret)).toBe(false);
  });

  it("allows local mock mode when no webhook secret is configured", () => {
    expect(verifyPaystackSignature("{}", undefined, undefined)).toBe(true);
  });
});
