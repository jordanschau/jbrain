import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { OllamaEmbeddingProvider } from '../../src/core/providers/ollama-embedding.ts';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

let originalFetch: typeof globalThis.fetch;
let captured: CapturedRequest[];
let nextResponse: { status: number; body: any } | (() => { status: number; body: any });

function installFetchMock() {
  originalFetch = globalThis.fetch;
  captured = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    const r = typeof nextResponse === 'function' ? nextResponse() : nextResponse;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OllamaEmbeddingProvider', () => {
  test('looks up known model dimensions (nomic-embed-text → 768)', () => {
    const p = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
    expect(p.dimensions).toBe(768);
  });

  test('strips ollama tag suffix when looking up dims', () => {
    const p = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:latest' });
    expect(p.dimensions).toBe(768);
  });

  test('throws on unknown model dims access before probe', () => {
    const p = new OllamaEmbeddingProvider({ model: 'totally-unknown-model' });
    expect(() => p.dimensions).toThrow(/unknown embedding dimensions/);
  });

  test('explicit dimensions override the known table', () => {
    const p = new OllamaEmbeddingProvider({
      model: 'nomic-embed-text',
      dimensions: 256,
    });
    expect(p.dimensions).toBe(256);
  });

  test('embedBatch posts to /api/embed with correct shape', async () => {
    nextResponse = { status: 200, body: { embeddings: [[0.5, 0.25, 0.125]], model: 'nomic-embed-text' } };
    const p = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
    const result = await p.embedBatch(['hello world']);

    expect(captured.length).toBe(1);
    expect(captured[0].url).toBe('http://localhost:11434/api/embed');
    expect(captured[0].method).toBe('POST');
    expect(captured[0].body).toEqual({ model: 'nomic-embed-text', input: ['hello world'] });
    expect(result.length).toBe(1);
    // Float32 values that round-trip exactly (powers of 2)
    expect(Array.from(result[0])).toEqual([0.5, 0.25, 0.125]);
  });

  test('honors custom host', async () => {
    nextResponse = { status: 200, body: { embeddings: [[1, 2]], model: 'm' } };
    const p = new OllamaEmbeddingProvider({
      model: 'nomic-embed-text',
      host: 'http://gpu-box:11434/',
    });
    await p.embedBatch(['x']);
    expect(captured[0].url).toBe('http://gpu-box:11434/api/embed');
  });

  test('truncates inputs per model (nomic → 4800 chars)', async () => {
    nextResponse = { status: 200, body: { embeddings: [[0]], model: 'm' } };
    const p = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
    await p.embedBatch(['a'.repeat(20000)]);
    expect(captured[0].body.input[0].length).toBe(4800);
  });

  test('truncates mxbai-embed-large to 1200 chars (512-token context)', async () => {
    nextResponse = { status: 200, body: { embeddings: [[0]], model: 'm' } };
    const p = new OllamaEmbeddingProvider({ model: 'mxbai-embed-large' });
    await p.embedBatch(['a'.repeat(20000)]);
    expect(captured[0].body.input[0].length).toBe(1200);
  });

  test('explicit maxChars overrides the known table', async () => {
    nextResponse = { status: 200, body: { embeddings: [[0]], model: 'm' } };
    const p = new OllamaEmbeddingProvider({ model: 'mxbai-embed-large', maxChars: 500 });
    await p.embedBatch(['a'.repeat(20000)]);
    expect(captured[0].body.input[0].length).toBe(500);
  });

  test('adaptive: halves inputs and retries on context-length 400', async () => {
    let calls = 0;
    nextResponse = (() => {
      calls++;
      if (calls === 1) {
        return { status: 400, body: { error: 'the input length exceeds the context length' } };
      }
      return { status: 200, body: { embeddings: [[1, 2, 3]], model: 'm' } };
    }) as any;

    const p = new OllamaEmbeddingProvider({ model: 'mxbai-embed-large' });
    const result = await p.embedBatch(['a'.repeat(1200)]);

    expect(result.length).toBe(1);
    expect(captured.length).toBe(2);
    expect(captured[0].body.input[0].length).toBe(1200);
    expect(captured[1].body.input[0].length).toBe(600);
  });

  test('probes dimensions for unknown model on first call', async () => {
    nextResponse = { status: 200, body: { embeddings: [[1, 2, 3, 4, 5]], model: 'm' } };
    const p = new OllamaEmbeddingProvider({ model: 'unknown-model' });
    await p.embedBatch(['probe']);
    expect(p.dimensions).toBe(5);
  });

  test('returns empty array for empty input without calling fetch', async () => {
    const p = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
    const result = await p.embedBatch([]);
    expect(result).toEqual([]);
    expect(captured.length).toBe(0);
  });

  test('throws on non-2xx response after retries', async () => {
    nextResponse = { status: 500, body: { error: 'boom' } };
    const p = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
    await expect(p.embedBatch(['x'])).rejects.toThrow(/Ollama \/api\/embed failed/);
  }, 60_000);
});
