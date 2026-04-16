import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { OllamaChatProvider } from '../../src/core/providers/ollama-chat.ts';

interface CapturedRequest {
  url: string;
  body: any;
}

let originalFetch: typeof globalThis.fetch;
let captured: CapturedRequest[];
let nextResponse: { status: number; body: any };

function installFetchMock() {
  originalFetch = globalThis.fetch;
  captured = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    captured.push({ url, body });
    return new Response(JSON.stringify(nextResponse.body), { status: nextResponse.status });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OllamaChatProvider', () => {
  test('complete() posts user message and returns content', async () => {
    nextResponse = {
      status: 200,
      body: { message: { role: 'assistant', content: 'hi back' }, done: true },
    };
    const p = new OllamaChatProvider({ model: 'llama3.2' });
    const result = await p.complete('hello');

    expect(result).toBe('hi back');
    expect(captured[0].url).toBe('http://localhost:11434/api/chat');
    expect(captured[0].body.model).toBe('llama3.2');
    expect(captured[0].body.stream).toBe(false);
    expect(captured[0].body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('complete() respects systemPrompt and maxTokens', async () => {
    nextResponse = { status: 200, body: { message: { role: 'assistant', content: '' } } };
    const p = new OllamaChatProvider({ model: 'llama3.2' });
    await p.complete('hello', { systemPrompt: 'be brief', maxTokens: 50, temperature: 0.2 });

    expect(captured[0].body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(captured[0].body.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(captured[0].body.options.num_predict).toBe(50);
    expect(captured[0].body.options.temperature).toBe(0.2);
  });

  test('completeJSON() includes format schema and parses JSON content', async () => {
    nextResponse = {
      status: 200,
      body: {
        message: {
          role: 'assistant',
          content: '{"alternative_queries": ["a", "b"]}',
        },
      },
    };
    const p = new OllamaChatProvider({ model: 'llama3.2' });
    const result = await p.completeJSON<{ alternative_queries: string[] }>('expand: foo', {
      schemaName: 'expand_query',
      schema: {
        type: 'object',
        properties: { alternative_queries: { type: 'array', items: { type: 'string' } } },
        required: ['alternative_queries'],
      },
    });

    expect(result.alternative_queries).toEqual(['a', 'b']);
    expect(captured[0].body.format).toBeDefined();
    expect((captured[0].body.format as any).type).toBe('object');
  });

  test('completeJSON() throws on non-JSON content', async () => {
    nextResponse = {
      status: 200,
      body: { message: { role: 'assistant', content: 'not json at all' } },
    };
    const p = new OllamaChatProvider({ model: 'llama3.2' });
    await expect(
      p.completeJSON('q', { schemaName: 's', schema: { type: 'object' } }),
    ).rejects.toThrow(/non-JSON/);
  });

  test('throws on Ollama HTTP error', async () => {
    nextResponse = { status: 500, body: { error: 'model not found' } };
    const p = new OllamaChatProvider({ model: 'missing-model' });
    await expect(p.complete('x')).rejects.toThrow(/Ollama \/api\/chat failed/);
  });

  test('honors custom host', async () => {
    nextResponse = { status: 200, body: { message: { content: 'ok' } } };
    const p = new OllamaChatProvider({ model: 'llama3.2', host: 'http://gpu-box:11434/' });
    await p.complete('x');
    expect(captured[0].url).toBe('http://gpu-box:11434/api/chat');
  });
});
