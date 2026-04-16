/**
 * Provider factory: selects embedding + chat providers from config + env vars.
 *
 * Precedence: env vars > GBrainConfig > defaults.
 *
 * Defaults preserve historical behavior: OpenAI text-embedding-3-large @ 1536d
 * for embeddings, Anthropic Claude Haiku for chat.
 */

import type {
  EmbeddingProvider,
  ChatProvider,
  EmbeddingProviderName,
  ChatProviderName,
} from './types.ts';
import { OpenAIEmbeddingProvider } from './openai-embedding.ts';
import { OllamaEmbeddingProvider } from './ollama-embedding.ts';
import { AnthropicChatProvider } from './anthropic-chat.ts';
import { OllamaChatProvider } from './ollama-chat.ts';

export interface ProviderConfig {
  embedding_provider?: EmbeddingProviderName;
  embedding_model?: string;
  embedding_dimensions?: number;
  chat_provider?: ChatProviderName;
  chat_model?: string;
  ollama_host?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
}

const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

let cachedEmbedding: EmbeddingProvider | null = null;
let cachedChat: ChatProvider | null = null;
let cachedConfigKey: string | null = null;

/** Reset cached providers. Tests should call this between cases. */
export function resetProviders(): void {
  cachedEmbedding = null;
  cachedChat = null;
  cachedConfigKey = null;
}

function readProviderConfig(override?: ProviderConfig): ProviderConfig {
  return {
    embedding_provider: (process.env.GBRAIN_EMBEDDING_PROVIDER as EmbeddingProviderName)
      || override?.embedding_provider,
    embedding_model: process.env.GBRAIN_EMBEDDING_MODEL || override?.embedding_model,
    embedding_dimensions: process.env.GBRAIN_EMBEDDING_DIMENSIONS
      ? Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS)
      : override?.embedding_dimensions,
    chat_provider: (process.env.GBRAIN_CHAT_PROVIDER as ChatProviderName)
      || override?.chat_provider,
    chat_model: process.env.GBRAIN_CHAT_MODEL || override?.chat_model,
    ollama_host: process.env.OLLAMA_HOST || override?.ollama_host || DEFAULT_OLLAMA_HOST,
    openai_api_key: process.env.OPENAI_API_KEY || override?.openai_api_key,
    anthropic_api_key: process.env.ANTHROPIC_API_KEY || override?.anthropic_api_key,
  };
}

function configKey(c: ProviderConfig): string {
  return JSON.stringify({
    ep: c.embedding_provider, em: c.embedding_model, ed: c.embedding_dimensions,
    cp: c.chat_provider, cm: c.chat_model, oh: c.ollama_host,
  });
}

export function getEmbeddingProvider(override?: ProviderConfig): EmbeddingProvider {
  const config = readProviderConfig(override);
  const key = configKey(config);
  if (cachedEmbedding && cachedConfigKey === key) return cachedEmbedding;

  const provider = config.embedding_provider ?? 'openai';

  let instance: EmbeddingProvider;
  if (provider === 'ollama') {
    instance = new OllamaEmbeddingProvider({
      model: config.embedding_model ?? 'nomic-embed-text',
      host: config.ollama_host,
      dimensions: config.embedding_dimensions,
    });
  } else if (provider === 'openai') {
    instance = new OpenAIEmbeddingProvider({
      model: config.embedding_model,
      dimensions: config.embedding_dimensions,
      apiKey: config.openai_api_key,
    });
  } else {
    throw new Error(`Unknown embedding provider: ${provider}`);
  }

  cachedEmbedding = instance;
  cachedConfigKey = key;
  return instance;
}

export function getChatProvider(override?: ProviderConfig): ChatProvider {
  const config = readProviderConfig(override);
  const key = configKey(config);
  if (cachedChat && cachedConfigKey === key) return cachedChat;

  const provider = config.chat_provider ?? 'anthropic';

  let instance: ChatProvider;
  if (provider === 'ollama') {
    instance = new OllamaChatProvider({
      model: config.chat_model,
      host: config.ollama_host,
    });
  } else if (provider === 'anthropic') {
    instance = new AnthropicChatProvider({
      model: config.chat_model,
      apiKey: config.anthropic_api_key,
    });
  } else {
    throw new Error(`Unknown chat provider: ${provider}`);
  }

  cachedChat = instance;
  cachedConfigKey = key;
  return instance;
}
