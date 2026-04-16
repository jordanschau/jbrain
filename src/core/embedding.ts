/**
 * Embedding Service: thin delegator over the active EmbeddingProvider.
 *
 * Provider selection (OpenAI, Ollama) is handled by src/core/providers/factory.ts
 * via env vars (GBRAIN_EMBEDDING_PROVIDER) or config. Defaults to OpenAI
 * text-embedding-3-large @ 1536d, preserving historical behavior.
 */

import { getEmbeddingProvider } from './providers/factory.ts';

export async function embed(text: string): Promise<Float32Array> {
  const result = await embedBatch([text]);
  return result[0];
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  return getEmbeddingProvider().embedBatch(texts);
}

/** Active embedding model name. Reads from the configured provider. */
export function getEmbeddingModel(): string {
  return getEmbeddingProvider().modelName;
}

/** Active embedding dimensions. Reads from the configured provider. */
export function getEmbeddingDimensions(): number {
  return getEmbeddingProvider().dimensions;
}
