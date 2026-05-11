import { z } from "zod";

import { env } from "../config/env.js";
import type { QuoteLineItemDto } from "../domain.js";

export interface GeneratedQuote {
  jobTitle: string;
  description: string;
  items: QuoteLineItemDto[];
  subtotalAmount: number;
  vatAmount: number;
  totalAmount: number;
  depositAmount: number;
  validUntil: string;
}

const vatRate = 0.075;

class OpenAiQuoteGenerationTimeoutError extends Error {
  constructor() {
    super("OpenAI quote generation timed out.");
  }
}

export class AiQuoteGenerationError extends Error {
  constructor(message = "AI quote generation failed.") {
    super(message);
  }
}

export type OpenAiFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

interface QuoteGenerationOptions {
  openAiApiKey?: string;
  openAiModel?: string;
  openAiFallbackModel?: string;
  openAiBaseUrl?: string;
  requestTimeoutMs?: number;
  fetchFn?: OpenAiFetch;
}

interface QuoteGenerationInput {
  prompt: string;
  collectDeposit: boolean;
  businessName?: string;
  serviceLine?: string;
}

type OpenAiQuoteRequestOptions = Required<
  Pick<QuoteGenerationOptions, "openAiApiKey" | "openAiModel" | "openAiBaseUrl" | "requestTimeoutMs" | "fetchFn">
>;

const aiQuoteSchema = z.object({
  jobTitle: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(400),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(90),
        quantityLabel: z.string().trim().min(1).max(40),
        unitAmount: z.number().int().positive().max(50_000_000),
        totalAmount: z.number().int().positive().max(50_000_000),
      }),
    )
    .min(1)
    .max(8),
});

const quoteJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobTitle", "description", "items"],
  properties: {
    jobTitle: {
      type: "string",
      description: "Short service title for the quote.",
    },
    description: {
      type: "string",
      description: "One-sentence quote description based on the customer's request.",
    },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "quantityLabel", "unitAmount", "totalAmount"],
        properties: {
          title: { type: "string" },
          quantityLabel: { type: "string" },
          unitAmount: { type: "integer", minimum: 1 },
          totalAmount: { type: "integer", minimum: 1 },
        },
      },
    },
  },
} as const;

const plumbingItems: Omit<QuoteLineItemDto, "id">[] = [
  { title: "PPR piping - 20mm", quantityLabel: "60 m", unitAmount: 1800, totalAmount: 108000 },
  { title: "PPR piping - 25mm", quantityLabel: "24 m", unitAmount: 2400, totalAmount: 57600 },
  { title: "Fittings, elbows, tees", quantityLabel: "1 lot", unitAmount: 18500, totalAmount: 18500 },
  { title: "Shut-off valves", quantityLabel: "6 pcs", unitAmount: 4200, totalAmount: 25200 },
  { title: "Labour - 2 plumbers x 3 days", quantityLabel: "6 days", unitAmount: 18000, totalAmount: 108000 },
  { title: "Removal of old copper + disposal", quantityLabel: "1 job", unitAmount: 15000, totalAmount: 15000 },
];

const softwareItems: Omit<QuoteLineItemDto, "id">[] = [
  { title: "Requirements review and April work plan", quantityLabel: "1 sprint", unitAmount: 60000, totalAmount: 60000 },
  { title: "Software feature development", quantityLabel: "1 month", unitAmount: 240000, totalAmount: 240000 },
  { title: "Testing, fixes, and deployment support", quantityLabel: "1 cycle", unitAmount: 90000, totalAmount: 90000 },
];

const hvacItems: Omit<QuoteLineItemDto, "id">[] = [
  { title: "AC diagnostic and service materials", quantityLabel: "1 lot", unitAmount: 45000, totalAmount: 45000 },
  { title: "Technician labour", quantityLabel: "1 job", unitAmount: 65000, totalAmount: 65000 },
  { title: "Transport and site logistics", quantityLabel: "1 visit", unitAmount: 15000, totalAmount: 15000 },
];

const genericItems: Omit<QuoteLineItemDto, "id">[] = [
  { title: "Materials and supplies", quantityLabel: "1 lot", unitAmount: 85000, totalAmount: 85000 },
  { title: "Skilled labour", quantityLabel: "3 days", unitAmount: 25000, totalAmount: 75000 },
  { title: "Transport and site logistics", quantityLabel: "1 job", unitAmount: 18000, totalAmount: 18000 },
  { title: "Cleanup and handover", quantityLabel: "1 job", unitAmount: 12000, totalAmount: 12000 },
];

export async function generateQuoteFromPrompt(
  input: QuoteGenerationInput,
  options: QuoteGenerationOptions = {},
): Promise<GeneratedQuote> {
  const openAiApiKey = options.openAiApiKey ?? env.OPENAI_API_KEY;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  if (!openAiApiKey || !fetchFn) {
    return generateDeterministicQuoteFromPrompt(input);
  }

  const openAiModel = options.openAiModel ?? env.OPENAI_QUOTE_MODEL;
  const fallbackModel = options.openAiFallbackModel ?? env.OPENAI_QUOTE_FALLBACK_MODEL;
  const models = [...new Set([openAiModel, fallbackModel].filter(Boolean))];
  const errors: string[] = [];

  for (const model of models) {
    try {
      return await generateQuoteWithOpenAi(input, {
        openAiApiKey,
        openAiModel: model,
        openAiBaseUrl: options.openAiBaseUrl ?? env.OPENAI_BASE_URL,
        requestTimeoutMs: options.requestTimeoutMs ?? env.OPENAI_REQUEST_TIMEOUT_MS,
        fetchFn,
      });
    } catch (error) {
      errors.push(`${model}: ${error instanceof Error ? error.message : "Unknown AI error"}`);
    }
  }

  throw new AiQuoteGenerationError(`AI quote generation failed. ${errors.join(" | ")}`);
}

export function generateDeterministicQuoteFromPrompt(input: QuoteGenerationInput): GeneratedQuote {
  const normalized = `${input.prompt} ${input.serviceLine ?? ""}`.toLowerCase();
  const isPlumbing = ["bathroom", "pipe", "ppr", "plumb", "copper"].some((keyword) =>
    normalized.includes(keyword),
  );
  const isSoftware = [
    "software",
    "engineering",
    "developer",
    "development",
    "website",
    "web app",
    "mobile app",
    "backend",
    "frontend",
    "api",
  ].some((keyword) => normalized.includes(keyword));
  const isHvac = ["ac", "a/c", "hvac", "air condition", "air-condition", "cooling"].some((keyword) =>
    normalized.includes(keyword),
  );
  const baseItems = isPlumbing ? plumbingItems : isSoftware ? softwareItems : isHvac ? hvacItems : genericItems;
  const jobTitle = isPlumbing
    ? "Full bathroom re-piping"
    : isSoftware
      ? "April software engineering tasks"
      : isHvac
        ? "AC / HVAC service job"
        : "Custom service job";
  const subtotalAmount = baseItems.reduce((sum, item) => sum + item.totalAmount, 0);
  const vatAmount = Math.round(subtotalAmount * vatRate);
  const totalAmount = subtotalAmount + vatAmount;

  return {
    jobTitle,
    description: input.prompt,
    items: baseItems.map((item, index) => ({
      id: `item-${String(index + 1).padStart(2, "0")}`,
      ...item,
    })),
    subtotalAmount,
    vatAmount,
    totalAmount,
    depositAmount: input.collectDeposit ? Math.round(totalAmount * 0.5) : 0,
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
}

async function generateQuoteWithOpenAi(
  input: QuoteGenerationInput,
  options: OpenAiQuoteRequestOptions,
): Promise<GeneratedQuote> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);

  try {
    const response = await options
      .fetchFn(`${trimTrailingSlash(options.openAiBaseUrl)}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.openAiApiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: options.openAiModel,
          input: [
            {
              role: "system",
              content:
                "You create practical Nigerian small-business service quotes. Prioritize the customer's explicit request over business context if they conflict. Return realistic whole NGN amounts only. Do not include VAT, deposit, discounts, markdown, or explanations.",
            },
            {
              role: "user",
              content: [
                input.businessName ? `Business name: ${input.businessName}` : null,
                input.serviceLine ? `Business offering: ${input.serviceLine}` : null,
                `Customer request: ${input.prompt}`,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          max_output_tokens: 1200,
          text: {
            format: {
              type: "json_schema",
              name: "quote_draft",
              strict: true,
              schema: quoteJsonSchema,
            },
          },
        }),
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          throw new OpenAiQuoteGenerationTimeoutError();
        }

        throw error;
      });

    if (!response.ok) {
      throw new Error(`OpenAI quote generation failed with status ${response.status}.`);
    }

    const payload = await response.json();
    const text = extractOutputText(payload);
    const parsed = aiQuoteSchema.parse(JSON.parse(text));
    return completeQuote(input, parsed);
  } finally {
    clearTimeout(timeout);
  }
}

function completeQuote(input: QuoteGenerationInput, quote: z.infer<typeof aiQuoteSchema>) {
  const items = quote.items.map((item, index) => ({
    id: `item-${String(index + 1).padStart(2, "0")}`,
    title: item.title,
    quantityLabel: item.quantityLabel,
    unitAmount: item.unitAmount,
    totalAmount: item.totalAmount,
  }));
  const subtotalAmount = items.reduce((sum, item) => sum + item.totalAmount, 0);
  const vatAmount = Math.round(subtotalAmount * vatRate);
  const totalAmount = subtotalAmount + vatAmount;

  return {
    jobTitle: quote.jobTitle,
    description: quote.description || input.prompt,
    items,
    subtotalAmount,
    vatAmount,
    totalAmount,
    depositAmount: input.collectDeposit ? Math.round(totalAmount * 0.5) : 0,
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
}

function extractOutputText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("OpenAI quote response was empty.");
  }

  if ("output_text" in payload && typeof payload.output_text === "string") {
    return payload.output_text;
  }

  if (!("output" in payload) || !Array.isArray(payload.output)) {
    throw new Error("OpenAI quote response did not include output text.");
  }

  for (const output of payload.output) {
    if (typeof output !== "object" || output === null || !("content" in output) || !Array.isArray(output.content)) {
      continue;
    }

    for (const content of output.content) {
      if (
        typeof content === "object" &&
        content !== null &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        return content.text;
      }
    }
  }

  throw new Error("OpenAI quote response did not include readable text.");
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function isAbortError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
