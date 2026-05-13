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
  /** Comma-separated Google OAuth client IDs (web/iOS/Android) accepted when verifying Google sign-in ID tokens. */
  GOOGLE_OAUTH_CLIENT_IDS: optionalString,
  /** WhatsApp Business Cloud API phone number ID that templates are sent from. */
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  /** WhatsApp Business Cloud API access token (long-lived system user token recommended). */
  WHATSAPP_ACCESS_TOKEN: optionalString,
  /** Approved authentication template name used to deliver OTP codes. */
  WHATSAPP_OTP_TEMPLATE_NAME: stringWithDefault("otp_code"),
  /** Language code for the authentication template (must match the approved template). */
  WHATSAPP_OTP_TEMPLATE_LANGUAGE: stringWithDefault("en"),
  /** Graph API version used for WhatsApp Cloud API calls. */
  WHATSAPP_API_VERSION: stringWithDefault("v22.0"),
  /** Graph API base URL. Override only for testing. */
  WHATSAPP_API_BASE_URL: stringWithDefault("https://graph.facebook.com"),
  /** When true, OTP responses include the generated code (for local development only). */
  EXPOSE_OTP_CODE: booleanWithDefault(false),
});

export const env = envSchema.parse(process.env);

export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const googleOAuthClientIds = (env.GOOGLE_OAUTH_CLIENT_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
