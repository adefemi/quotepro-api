import { env } from "../config/env.js";

export interface WhatsAppOtpInput {
  phone: string;
  code: string;
}

export class WhatsAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppConfigError";
  }
}

export class WhatsAppDeliveryError extends Error {
  readonly statusCode?: number;
  readonly responseBody?: string;

  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message);
    this.name = "WhatsAppDeliveryError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export interface WhatsAppOtpSenderConfig {
  phoneNumberId?: string;
  accessToken?: string;
  templateName?: string;
  templateLanguage?: string;
  apiVersion?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export type WhatsAppOtpSender = (input: WhatsAppOtpInput) => Promise<void>;

export function createWhatsAppOtpSender(config: WhatsAppOtpSenderConfig = {}): WhatsAppOtpSender {
  const phoneNumberId = config.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = config.accessToken ?? env.WHATSAPP_ACCESS_TOKEN;
  const templateName = config.templateName ?? env.WHATSAPP_OTP_TEMPLATE_NAME;
  const templateLanguage = config.templateLanguage ?? env.WHATSAPP_OTP_TEMPLATE_LANGUAGE;
  const apiVersion = config.apiVersion ?? env.WHATSAPP_API_VERSION;
  const apiBaseUrl = (config.apiBaseUrl ?? env.WHATSAPP_API_BASE_URL).replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;

  return async ({ phone, code }) => {
    if (!phoneNumberId || !accessToken) {
      throw new WhatsAppConfigError(
        "WhatsApp Cloud API is not configured. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN.",
      );
    }

    const recipient = phone.replace(/[^\d]/g, "");
    if (!recipient) {
      throw new WhatsAppDeliveryError("Recipient phone number is invalid.");
    }

    const url = `${apiBaseUrl}/${apiVersion}/${phoneNumberId}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: {
        name: templateName,
        language: { code: templateLanguage },
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: code }],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: code }],
          },
        ],
      },
    };

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new WhatsAppDeliveryError(
        error instanceof Error ? error.message : "WhatsApp request failed.",
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new WhatsAppDeliveryError(
        `WhatsApp Cloud API responded with ${response.status}.`,
        response.status,
        body,
      );
    }
  };
}
