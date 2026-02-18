import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIEmbeddingProvider } from "../embeddings/openai-provider";

describe("OpenAIEmbeddingProvider", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requests embeddings and captures dimensions", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          data: [
            { embedding: [0.3, 0.4], index: 1 },
            { embedding: [0.1, 0.2], index: 0 },
          ],
        }),
    } as Response);

    global.fetch = mockFetch as typeof fetch;

    const provider = new OpenAIEmbeddingProvider({
      model: "test-model",
      apiKey: "test-key",
      baseUrl: "https://example.com",
    });

    const embeddings = await provider.embed(["alpha", "beta"]);

    expect(embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(provider.dimensions).toBe(2);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/v1/embeddings",
      expect.objectContaining({ method: "POST" })
    );

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      model: "test-model",
      input: ["alpha", "beta"],
    });

    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("surfaces error payloads for failed responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () =>
        JSON.stringify({
          error: {
            message: "Invalid API key",
          },
        }),
    } as Response);

    global.fetch = mockFetch as typeof fetch;

    const provider = new OpenAIEmbeddingProvider({
      model: "test-model",
      apiKey: "bad-key",
      baseUrl: "https://example.com/v1",
    });

    await expect(provider.embed(["alpha"]))
      .rejects.toThrow("Embedding request failed (401 Unauthorized): Invalid API key");
  });
});
