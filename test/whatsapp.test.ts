import { describe, expect, it, vi } from "vitest";

import {
  createWhatsAppOtpSender,
  WhatsAppConfigError,
  WhatsAppDeliveryError,
} from "../src/notifications/whatsapp.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetchMock(impl: (input: string, init: RequestInit) => Promise<Response>) {
  return vi.fn<(input: string, init: RequestInit) => Promise<Response>>(impl);
}

describe("createWhatsAppOtpSender", () => {
  it("posts the authentication template payload to the Cloud API", async () => {
    const fetchImpl = makeFetchMock(async () =>
      jsonResponse({ messages: [{ id: "wamid.test" }] }),
    );
    const send = createWhatsAppOtpSender({
      phoneNumberId: "123456789",
      accessToken: "token-abc",
      apiVersion: "v22.0",
      apiBaseUrl: "https://example.com",
      templateName: "otp_code",
      templateLanguage: "en",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await send({ phone: "+234 803 221 4490", code: "123456" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.com/v22.0/123456789/messages");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "2348032214490",
      type: "template",
      template: {
        name: "otp_code",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "123456" }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "123456" }],
          },
        ],
      },
    });
  });

  it("trims trailing slashes from the API base URL", async () => {
    const fetchImpl = makeFetchMock(async () => jsonResponse({}));
    const send = createWhatsAppOtpSender({
      phoneNumberId: "999",
      accessToken: "tok",
      apiBaseUrl: "https://example.com/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await send({ phone: "2348012345678", code: "000111" });

    expect(fetchImpl.mock.calls[0][0]).toBe("https://example.com/v22.0/999/messages");
  });

  it("throws WhatsAppConfigError when phone number id or access token is missing", async () => {
    const fetchImpl = makeFetchMock(async () => jsonResponse({}));
    const send = createWhatsAppOtpSender({
      phoneNumberId: undefined,
      accessToken: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(send({ phone: "+234", code: "123456" })).rejects.toBeInstanceOf(
      WhatsAppConfigError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws WhatsAppDeliveryError when the recipient phone is invalid", async () => {
    const fetchImpl = makeFetchMock(async () => jsonResponse({}));
    const send = createWhatsAppOtpSender({
      phoneNumberId: "123",
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(send({ phone: "++--", code: "123456" })).rejects.toBeInstanceOf(
      WhatsAppDeliveryError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws WhatsAppDeliveryError when fetch throws", async () => {
    const fetchImpl = makeFetchMock(async () => {
      throw new Error("ECONNRESET");
    });
    const send = createWhatsAppOtpSender({
      phoneNumberId: "123",
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await send({ phone: "+2348000000000", code: "123456" }).catch((err) => err);
    expect(error).toBeInstanceOf(WhatsAppDeliveryError);
    expect((error as WhatsAppDeliveryError).message).toContain("ECONNRESET");
  });

  it("throws WhatsAppDeliveryError when fetch rejects with a non-Error value", async () => {
    const fetchImpl = makeFetchMock(async () => {
      throw "boom";
    });
    const send = createWhatsAppOtpSender({
      phoneNumberId: "123",
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await send({ phone: "+2348000000000", code: "123456" }).catch((err) => err);
    expect(error).toBeInstanceOf(WhatsAppDeliveryError);
    expect((error as WhatsAppDeliveryError).message).toBe("WhatsApp request failed.");
  });

  it("throws WhatsAppDeliveryError carrying status and body when the API responds with an error", async () => {
    const fetchImpl = makeFetchMock(
      async () =>
        new Response("invalid recipient", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const send = createWhatsAppOtpSender({
      phoneNumberId: "123",
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await send({ phone: "+2348000000000", code: "123456" }).catch((err) => err);
    expect(error).toBeInstanceOf(WhatsAppDeliveryError);
    expect((error as WhatsAppDeliveryError).statusCode).toBe(400);
    expect((error as WhatsAppDeliveryError).responseBody).toBe("invalid recipient");
  });

  it("falls back to an empty body when reading the error response fails", async () => {
    const fakeResponse = {
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("read failed");
      },
    } as unknown as Response;
    const fetchImpl = makeFetchMock(async () => fakeResponse);
    const send = createWhatsAppOtpSender({
      phoneNumberId: "123",
      accessToken: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await send({ phone: "+2348000000000", code: "123456" }).catch((err) => err);
    expect(error).toBeInstanceOf(WhatsAppDeliveryError);
    expect((error as WhatsAppDeliveryError).statusCode).toBe(500);
    expect((error as WhatsAppDeliveryError).responseBody).toBe("");
  });
});
