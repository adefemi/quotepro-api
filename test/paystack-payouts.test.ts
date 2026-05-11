import { afterEach, describe, expect, it, vi } from "vitest";

async function loadMockPayoutHelpers() {
  vi.resetModules();
  vi.stubEnv("PAYSTACK_SECRET_KEY", "");
  return import("../src/payments/paystack.js");
}

describe("Paystack payout helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns mock banks when Paystack secret is missing", async () => {
    const { listPaystackBanks } = await loadMockPayoutHelpers();

    const banks = await listPaystackBanks();

    expect(banks).toContainEqual({ name: "Guaranty Trust Bank", code: "058" });
  });

  it("resolves account details and recipient code in mock mode", async () => {
    const { createPaystackTransferRecipient, resolvePaystackBankAccount } =
      await loadMockPayoutHelpers();

    const resolved = await resolvePaystackBankAccount({
      accountNumber: "0123452018",
      bankCode: "058",
    });
    const recipient = await createPaystackTransferRecipient({
      accountNumber: resolved.accountNumber,
      bankCode: "058",
      accountName: resolved.accountName,
    });

    expect(resolved).toEqual({
      accountNumber: "0123452018",
      accountName: "Verified Paystack Account",
    });
    expect(recipient.recipientCode).toBe("mock_recipient_058_2018");
  });
});

