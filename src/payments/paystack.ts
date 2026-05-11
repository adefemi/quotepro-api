import { createHmac, randomBytes } from "node:crypto";

import { env } from "../config/env.js";

export interface PaymentInitializationInput {
  email: string;
  amount: number;
  quoteId: string;
  publicSlug: string;
  channel: string;
  callbackUrl: string;
}

export interface PaymentInitializationResult {
  authorizationUrl: string;
  reference: string;
  publicKey?: string;
  mode: "live" | "mock";
}

export interface PaymentVerificationResult {
  paymentStatus: WebhookTransition["paymentStatus"];
  eventLabel: string;
  rawPayload: unknown;
}

export interface PaystackBank {
  name: string;
  code: string;
}

export interface PaystackResolvedAccount {
  accountNumber: string;
  accountName: string;
}

export interface PaystackTransferRecipient {
  recipientCode: string;
}

interface PaystackResponse<T> {
  status: boolean;
  message?: string;
  data: T;
}

interface PaystackBankResponse {
  name?: string;
  code?: string;
  active?: boolean;
}

interface PaystackResolveResponse {
  account_number: string;
  account_name: string;
}

interface PaystackRecipientResponse {
  recipient_code: string;
}

interface PaystackTransactionVerifyResponse {
  reference: string;
  status: string;
}

export interface WebhookTransition {
  paymentStatus: "pending" | "initialized" | "paid" | "failed";
  quoteEvent: "deposit_paid" | "payment_failed" | "ignored";
  label: string;
}

const mockBanks: PaystackBank[] = [
  { name: "Access Bank", code: "044" },
  { name: "First Bank of Nigeria", code: "011" },
  { name: "Guaranty Trust Bank", code: "058" },
];

export function mapPaystackWebhookEvent(eventName: string): WebhookTransition {
  switch (eventName) {
    case "charge.success":
      return { paymentStatus: "paid", quoteEvent: "deposit_paid", label: "Deposit paid via Paystack" };
    case "charge.failed":
      return { paymentStatus: "failed", quoteEvent: "payment_failed", label: "Payment failed via Paystack" };
    default:
      return { paymentStatus: "pending", quoteEvent: "ignored", label: "Ignored Paystack event" };
  }
}

function mapPaystackTransactionStatus(status: string): Pick<PaymentVerificationResult, "paymentStatus" | "eventLabel"> {
  switch (status) {
    case "success":
      return { paymentStatus: "paid", eventLabel: "Deposit paid via Paystack" };
    case "failed":
    case "abandoned":
      return { paymentStatus: "failed", eventLabel: "Payment failed via Paystack" };
    default:
      return { paymentStatus: "pending", eventLabel: "Payment pending via Paystack" };
  }
}

export function verifyPaystackSignature(rawBody: string, signature: string | undefined, secret: string | undefined) {
  if (!secret) {
    return true;
  }

  if (!signature) {
    return false;
  }

  const digest = createHmac("sha512", secret).update(rawBody).digest("hex");
  return digest === signature;
}

function useMockPayouts() {
  return !env.PAYSTACK_SECRET_KEY;
}

function paystackHeaders() {
  return {
    Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

async function readPaystackJson<T>(response: Response): Promise<PaystackResponse<T>> {
  const payload = (await response.json()) as PaystackResponse<T>;

  if (!response.ok || payload.status === false) {
    throw new Error(payload.message ?? "Paystack request failed.");
  }

  return payload;
}

export async function listPaystackBanks(): Promise<PaystackBank[]> {
  if (useMockPayouts()) {
    return mockBanks;
  }

  const response = await fetch("https://api.paystack.co/bank?country=nigeria&type=nuban&perPage=100", {
    method: "GET",
    headers: paystackHeaders(),
  });
  const payload = await readPaystackJson<PaystackBankResponse[]>(response);

  return payload.data
    .filter((bank) => bank.active !== false && bank.name && bank.code)
    .map((bank) => ({ name: bank.name!, code: bank.code! }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function resolvePaystackBankAccount(input: {
  accountNumber: string;
  bankCode: string;
}): Promise<PaystackResolvedAccount> {
  if (useMockPayouts()) {
    return {
      accountNumber: input.accountNumber,
      accountName: "Verified Paystack Account",
    };
  }

  const params = new URLSearchParams({
    account_number: input.accountNumber,
    bank_code: input.bankCode,
  });
  const response = await fetch(`https://api.paystack.co/bank/resolve?${params.toString()}`, {
    method: "GET",
    headers: paystackHeaders(),
  });
  const payload = await readPaystackJson<PaystackResolveResponse>(response);

  return {
    accountNumber: payload.data.account_number,
    accountName: payload.data.account_name,
  };
}

export async function createPaystackTransferRecipient(input: {
  accountNumber: string;
  bankCode: string;
  accountName: string;
}): Promise<PaystackTransferRecipient> {
  if (useMockPayouts()) {
    return {
      recipientCode: `mock_recipient_${input.bankCode}_${input.accountNumber.slice(-4)}`,
    };
  }

  const response = await fetch("https://api.paystack.co/transferrecipient", {
    method: "POST",
    headers: paystackHeaders(),
    body: JSON.stringify({
      type: "nuban",
      name: input.accountName,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: "NGN",
    }),
  });
  const payload = await readPaystackJson<PaystackRecipientResponse>(response);

  return {
    recipientCode: payload.data.recipient_code,
  };
}

export async function initializePayment(
  input: PaymentInitializationInput,
): Promise<PaymentInitializationResult> {
  if (env.MOCK_PAYMENTS || !env.PAYSTACK_SECRET_KEY) {
    return {
      authorizationUrl: `${input.callbackUrl}?reference=mock_${input.quoteId.toLowerCase()}`,
      reference: `mock_${input.quoteId.toLowerCase()}`,
      mode: "mock",
    };
  }

  if (!env.PAYSTACK_PUBLIC_KEY) {
    throw new Error("Paystack public key is not configured.");
  }

  const reference = `qp-${input.quoteId.toLowerCase()}-${randomBytes(6).toString("hex")}`;

  return {
    authorizationUrl: `${input.callbackUrl}?reference=${encodeURIComponent(reference)}`,
    reference,
    publicKey: env.PAYSTACK_PUBLIC_KEY,
    mode: "live",
  };
}

export async function verifyPaystackTransaction(reference: string): Promise<PaymentVerificationResult> {
  if (env.MOCK_PAYMENTS || !env.PAYSTACK_SECRET_KEY) {
    return {
      paymentStatus: "paid",
      eventLabel: "Mock deposit paid",
      rawPayload: { event: "mock.charge.success", data: { reference } },
    };
  }

  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    method: "GET",
    headers: paystackHeaders(),
  });
  const payload = await readPaystackJson<PaystackTransactionVerifyResponse>(response);
  const mapped = mapPaystackTransactionStatus(payload.data.status);

  return {
    ...mapped,
    rawPayload: payload,
  };
}
