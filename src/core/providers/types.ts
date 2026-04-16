/**
 * Provider interfaces for embedding generation and chat completion.
 *
 * Allows swapping between hosted APIs (OpenAI, Anthropic) and local models
 * (Ollama). Selected by the factory based on config and env vars.
 */

export interface EmbeddingProvider {
  /** Model identifier, persisted on chunks for staleness detection. */
  readonly modelName: string;
  /** Vector dimension. Must match the engine's vector column width. */
  readonly dimensions: number;
  /** Embed a batch of texts. Implementations own batching, retry, truncation. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export interface CompleteOpts {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface CompleteJSONOpts extends CompleteOpts {
  /** Tool/schema name (Anthropic tool_use, Ollama format). */
  schemaName: string;
  /** Optional human-readable description (Anthropic tool description). */
  schemaDescription?: string;
  /** JSON Schema object describing the expected output shape. */
  schema: Record<string, unknown>;
}

export interface ChatProvider {
  readonly modelName: string;
  /** Plain text completion. */
  complete(prompt: string, opts?: CompleteOpts): Promise<string>;
  /** Structured JSON completion. Returns parsed object matching the schema. */
  completeJSON<T = unknown>(prompt: string, opts: CompleteJSONOpts): Promise<T>;
}

export type EmbeddingProviderName = 'openai' | 'ollama';
export type ChatProviderName = 'anthropic' | 'ollama';
