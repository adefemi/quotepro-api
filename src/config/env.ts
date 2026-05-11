import { config } from "dotenv";
import { z } from "zod";

config({ path: ".env" });

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const stringWithDefault = (defaultValue: string) => z.preprocess(emptyToUndefined, z.string().default(defaultValue));
const positiveIntWithDefault = (defaultValue: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(defaultValue));
const booleanWithDefault = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === "") {
      return undefined;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no", "off"].includes(normalized)) {
        return false;
      }
    }

    return value;
  }, z.boolean().default(defaultValue));

const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().default("postgres://quotepro:quotepro@localhost:5432/quotepro"),
  APP_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:4000"),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  PAYSTACK_WEBHOOK_SECRET: z.string().optional(),
  MOCK_PAYMENTS: booleanWithDefault(true),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: optionalUrl,
  S3_PUBLIC_BASE_URL: optionalUrl,
  OPENAI_API_KEY: optionalString,
  OPENAI_QUOTE_MODEL: stringWithDefault("gpt-5.3-chat-latest"),
  OPENAI_QUOTE_FALLBACK_MODEL: stringWithDefault("gpt-5.3-chat-latest"),
  OPENAI_BASE_URL: stringWithDefault("https://api.openai.com/v1"),
  OPENAI_REQUEST_TIMEOUT_MS: positiveIntWithDefault(25_000),
  /** Full JSON string (e.g. CI secrets). Takes precedence over file. */
  FIREBASE_SERVICE_ACCOUNT_JSON: optionalString,
  /** Path relative to the `api/` directory, or absolute. Default: `firebase.json`. Ignored if FIREBASE_SERVICE_ACCOUNT_JSON is set. */
  FIREBASE_SERVICE_ACCOUNT_PATH: optionalString,
});

export const env = envSchema.parse(process.env);

export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
