import { createHmac } from "node:crypto";

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
  mode: "live" | "mock";
}

interface PaystackInitializeResponse {
  status: boolean;
  data: {
    authorization_url: string;
    reference: string;
  };
}

export interface WebhookTransition {
  paymentStatus: "pending" | "initialized" | "paid" | "failed";
  quoteEvent: "deposit_paid" | "payment_failed" | "ignored";
  label: string;
}

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

  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email,
      amount: input.amount * 100,
      callback_url: input.callbackUrl,
      channels: [input.channel],
      metadata: {
        quoteId: input.quoteId,
        publicSlug: input.publicSlug,
      },
    }),
  });

  if (!response.ok) {
    throw new Error("Unable to initialize Paystack payment.");
  }

  const payload = (await response.json()) as PaystackInitializeResponse;

  return {
    authorizationUrl: payload.data.authorization_url,
    reference: payload.data.reference,
    mode: "live",
  };
}
