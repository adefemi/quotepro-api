import { z } from "zod";

export const quoteStatuses = ["draft", "sent", "viewed", "accepted", "partial", "paid", "expired", "archived"] as const;
export const paymentStatuses = ["pending", "initialized", "paid", "failed"] as const;

export type QuoteStatus = (typeof quoteStatuses)[number];
export type PaymentStatus = (typeof paymentStatuses)[number];

export interface ProviderProfileDto {
  id: string;
  businessName: string;
  serviceLine: string;
  customerPhone: string;
  accountPhone?: string;
  hasAccount: boolean;
  hasPin: boolean;
  hasLogo: boolean;
  hasPayoutAccount: boolean;
  payoutBankName?: string;
  payoutAccountLast4?: string;
}

export interface CompanyProfileDto {
  id: string;
  providerId: string;
  businessName: string;
  serviceLine: string;
  customerPhone: string;
  logoUrl?: string;
  isDefault: boolean;
}

export interface PayoutAccountDto {
  id: string;
  providerId: string;
  bankName: string;
  bankCode?: string;
  accountLast4: string;
  accountName?: string;
  isDefault: boolean;
}

export interface PayoutBankDto {
  name: string;
  code: string;
}

export interface QuoteLineItemDto {
  id: string;
  title: string;
  quantityLabel: string;
  unitAmount: number;
  totalAmount: number;
}

export interface QuoteDto {
  id: string;
  publicSlug: string;
  providerId: string;
  customerName: string;
  customerPhone: string;
  customerLocation: string;
  jobTitle: string;
  description: string;
  subtotalAmount: number;
  vatAmount: number;
  totalAmount: number;
  depositAmount: number;
  validUntil: string;
  status: QuoteStatus;
  collectDeposit: boolean;
  company?: CompanyProfileDto;
  items: QuoteLineItemDto[];
}

export interface QuoteEventDto {
  id: string;
  quoteId: string;
  kind: string;
  label: string;
  at: string;
}

export interface QuoteBundleDto {
  quote: QuoteDto;
  provider: ProviderProfileDto;
  timeline: QuoteEventDto[];
}

export interface PaymentRecordDto {
  id: string;
  quoteId: string;
  amount: number;
  reference: string;
  status: PaymentStatus;
}

export const signInSchema = z.object({
  channel: z.enum(["google", "phone", "demo"]).default("demo"),
});

export const otpStartSchema = z.object({
  phone: z.string().trim().min(6),
});

export const otpVerifySchema = z.object({
  phone: z.string().trim().min(6),
  code: z.string().trim().length(6),
});

export const pinSchema = z.object({
  pin: z.string().trim().regex(/^\d{4}$/),
});

export const pinLoginSchema = z.object({
  phone: z.string().trim().min(6),
  pin: z.string().trim().regex(/^\d{4}$/),
});

export const providerProfileSchema = z.object({
  businessName: z.string().trim().min(1),
  serviceLine: z.string().trim().min(1),
  customerPhone: z.string().trim().optional().default(""),
});

export const companyProfileSchema = z.object({
  businessName: z.string().trim().min(1),
  serviceLine: z.string().trim().min(1),
  customerPhone: z.string().trim().optional().default(""),
  logoUrl: z.string().trim().url().optional(),
});

export const payoutSchema = z.object({
  bankName: z.string().trim().min(1),
  bankCode: z.string().trim().min(1),
  accountNumber: z.string().trim().regex(/^\d{10}$/),
});

export const payoutAccountResolveSchema = z.object({
  bankCode: z.string().trim().min(1),
  accountNumber: z.string().trim().regex(/^\d{10}$/),
});

export const createQuoteSchema = z.object({
  companyId: z.string().uuid().optional(),
  customerName: z.string().trim().min(1),
  customerPhone: z.string().trim().optional().default(""),
  customerLocation: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  collectDeposit: z.boolean().optional().default(true),
  jobTitle: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        quantityLabel: z.string().trim().min(1),
        unitAmount: z.number().int().nonnegative(),
        totalAmount: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

export const updateQuoteSchema = z.object({
  collectDeposit: z.boolean().optional(),
  status: z.enum(quoteStatuses).optional(),
  customerName: z.string().trim().min(1).optional(),
  customerPhone: z.string().trim().optional(),
  customerLocation: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).optional(),
  jobTitle: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        quantityLabel: z.string().trim().min(1),
        unitAmount: z.number().int().nonnegative(),
        totalAmount: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

export const sendQuoteSchema = z.object({
  channel: z.enum(["link", "whatsapp", "sms", "email"]).default("link"),
  destination: z.string().trim().optional(),
});

export const initializePaymentSchema = z.object({
  email: z.string().email(),
  channel: z.enum(["card", "bank_transfer", "ussd"]).default("card"),
  publicSlug: z.string().min(1),
});

export const pushTokenUpsertSchema = z.object({
  token: z.string().trim().min(1),
  platform: z.enum(["ios", "android"]),
  appVersion: z.string().trim().optional(),
  deviceId: z.string().trim().optional(),
});

export const pushTokenDeleteSchema = z.object({
  token: z.string().trim().min(1),
});

export interface ProviderNotificationDto {
  id: string;
  quoteId: string | null;
  kind: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export type NotificationPushKind = "viewed" | "accepted" | "deposit_paid" | "payment_failed";

export interface NotificationPushPayload {
  providerId: string;
  notificationId: string;
  quoteId: string;
  kind: NotificationPushKind;
  title: string;
  body: string;
}

export interface QuotePublicActionResult {
  bundle: QuoteBundleDto;
  pushTarget: NotificationPushPayload;
}
