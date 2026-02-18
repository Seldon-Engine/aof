import { z } from "zod";

import type { EmbeddingProvider } from "./provider";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const EmbeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().optional(),
    })
  ),
});

const ErrorResponseSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
    })
    .optional(),
});

type OpenAIEmbeddingsRequest = {
  model: string;
  input: string[];
  dimensions?: number;
};

export type OpenAIEmbeddingProviderOptions = {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
};

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly requestedDimensions?: number;
  private dimensionsValue: number;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.requestedDimensions = options.dimensions;
    this.dimensionsValue = options.dimensions ?? 0;

    const normalizedBaseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.endpoint = `${normalizedBaseUrl}/embeddings`;
  }

  get dimensions(): number {
    return this.dimensionsValue;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const payload: OpenAIEmbeddingsRequest = {
      model: this.model,
      input: texts,
    };

    if (this.requestedDimensions) {
      payload.dimensions = this.requestedDimensions;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: buildHeaders(this.apiKey),
      body: JSON.stringify(payload),
    });

    const raw = await parseJson(response);

    if (!response.ok) {
      const errorMessage = extractErrorMessage(raw);
      const suffix = errorMessage ? `: ${errorMessage}` : "";
      throw new Error(
        `Embedding request failed (${response.status} ${response.statusText})${suffix}`
      );
    }

    const parsed = EmbeddingResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Embedding response payload did not match expected schema");
    }

    const embeddings = orderEmbeddings(parsed.data.data);
    if (embeddings.length !== texts.length) {
      throw new Error(
        `Embedding response length mismatch (expected ${texts.length}, got ${embeddings.length})`
      );
    }

    const detectedDimensions = embeddings[0]?.length ?? 0;
    if (detectedDimensions === 0) {
      throw new Error("Embedding response did not include vector dimensions");
    }

    if (this.dimensionsValue === 0) {
      this.dimensionsValue = detectedDimensions;
    } else if (this.dimensionsValue !== detectedDimensions) {
      throw new Error(
        `Embedding dimensions mismatch (expected ${this.dimensionsValue}, got ${detectedDimensions})`
      );
    }

    return embeddings;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

function buildHeaders(apiKey?: string): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    return {
      ...headers,
      Authorization: `Bearer ${apiKey}`,
    };
  }

  return headers;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Embedding response was not valid JSON", { cause: error });
  }
}

function extractErrorMessage(raw: unknown): string | undefined {
  const parsed = ErrorResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }

  return parsed.data.error?.message;
}

function orderEmbeddings(
  items: Array<{ embedding: number[]; index?: number }>
): number[][] {
  if (items.every((item) => typeof item.index === "number")) {
    return [...items]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((item) => item.embedding);
  }

  return items.map((item) => item.embedding);
}
