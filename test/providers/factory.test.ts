import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  getEmbeddingProvider,
  getChatProvider,
  resetProviders,
} from '../../src/core/providers/factory.ts';
import { OpenAIEmbeddingProvider } from '../../src/core/providers/openai-embedding.ts';
import { OllamaEmbeddingProvider } from '../../src/core/providers/ollama-embedding.ts';
import { AnthropicChatProvider } from '../../src/core/providers/anthropic-chat.ts';
import { OllamaChatProvider } from '../../src/core/providers/ollama-chat.ts';

const ENV_KEYS = [
  'GBRAIN_EMBEDDING_PROVIDER',
  'GBRAIN_EMBEDDING_MODEL',
  'GBRAIN_EMBEDDING_DIMENSIONS',
  'GBRAIN_CHAT_PROVIDER',
  'GBRAIN_CHAT_MODEL',
  'OLLAMA_HOST',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetProviders();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetProviders();
});

describe('embedding provider factory', () => {
  test('defaults to OpenAI text-embedding-3-large @ 1536d', () => {
    const p = getEmbeddingProvider();
    expect(p).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(p.modelName).toBe('text-embedding-3-large');
    expect(p.dimensions).toBe(1536);
  });

  test('GBRAIN_EMBEDDING_PROVIDER=ollama returns Ollama provider', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'nomic-embed-text';
    const p = getEmbeddingProvider();
    expect(p).toBeInstanceOf(OllamaEmbeddingProvider);
    expect(p.modelName).toBe('nomic-embed-text');
    expect(p.dimensions).toBe(768);
  });

  test('GBRAIN_EMBEDDING_DIMENSIONS overrides for unknown Ollama model', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'my-custom-model';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '512';
    const p = getEmbeddingProvider();
    expect(p.dimensions).toBe(512);
  });

  test('config override works for ollama_host', () => {
    const p = getEmbeddingProvider({
      embedding_provider: 'ollama',
      embedding_model: 'mxbai-embed-large',
      ollama_host: 'http://gpu-box:11434',
    });
    expect(p).toBeInstanceOf(OllamaEmbeddingProvider);
    expect(p.dimensions).toBe(1024);
  });

  test('caches across calls with the same config', () => {
    const a = getEmbeddingProvider();
    const b = getEmbeddingProvider();
    expect(a).toBe(b);
  });

  test('rebuilds when config changes', () => {
    const a = getEmbeddingProvider();
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'nomic-embed-text';
    const b = getEmbeddingProvider();
    expect(a).not.toBe(b);
  });
});

describe('chat provider factory', () => {
  test('defaults to Anthropic Claude Haiku', () => {
    const p = getChatProvider();
    expect(p).toBeInstanceOf(AnthropicChatProvider);
    expect(p.modelName).toBe('claude-haiku-4-5-20251001');
  });

  test('GBRAIN_CHAT_PROVIDER=ollama returns Ollama chat', () => {
    process.env.GBRAIN_CHAT_PROVIDER = 'ollama';
    process.env.GBRAIN_CHAT_MODEL = 'llama3.2';
    const p = getChatProvider();
    expect(p).toBeInstanceOf(OllamaChatProvider);
    expect(p.modelName).toBe('llama3.2');
  });

  test('Ollama chat defaults to llama3.2 when no model specified', () => {
    process.env.GBRAIN_CHAT_PROVIDER = 'ollama';
    const p = getChatProvider();
    expect(p.modelName).toBe('llama3.2');
  });
});
