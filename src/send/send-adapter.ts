export interface SendResult {
  status: "recorded";
  providerResponse: Record<string, unknown>;
}

export async function recordSendIntent(input: {
  channel: string;
  destination?: string;
  publicUrl: string;
}): Promise<SendResult> {
  return {
    status: "recorded",
    providerResponse: {
      channel: input.channel,
      destination: input.destination ?? null,
      publicUrl: input.publicUrl,
    },
  };
}
