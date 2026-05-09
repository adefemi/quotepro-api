import "dotenv/config";

import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const stringWithDefault = (defaultValue: string) => z.preprocess(emptyToUndefined, z.string().default(defaultValue));
const positiveIntWithDefault = (defaultValue: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(defaultValue));

const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().default("postgres://quotepro:quotepro@localhost:5432/quotepro"),
  APP_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:4000"),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_WEBHOOK_SECRET: z.string().optional(),
  MOCK_PAYMENTS: z.coerce.boolean().default(true),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: optionalUrl,
  S3_PUBLIC_BASE_URL: optionalUrl,
  OPENAI_API_KEY: optionalString,
  OPENAI_QUOTE_MODEL: stringWithDefault("gpt-5-nano"),
  OPENAI_QUOTE_FALLBACK_MODEL: stringWithDefault("gpt-4.1-mini"),
  OPENAI_BASE_URL: stringWithDefault("https://api.openai.com/v1"),
  OPENAI_REQUEST_TIMEOUT_MS: positiveIntWithDefault(8_000),
});

export const env = envSchema.parse(process.env);

export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
