/**
 * Ollama embedding provider. Calls POST {host}/api/embed (batch endpoint, Ollama 0.2+).
 *
 * Dimensions: looked up from a known-models table; can be overridden via constructor
 * arg; falls back to a probe call on first embedBatch if still unknown.
 */

import type { EmbeddingProvider } from './types.ts';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_MAX_CHARS = 2000; // Safe for 512-token models (~4 chars/token)

const KNOWN_DIMENSIONS: Record<string, number> = {
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'snowflake-arctic-embed': 1024,
  'snowflake-arctic-embed2': 1024,
  'bge-m3': 1024,
  'bge-large': 1024,
  'all-minilm': 384,
  'embeddinggemma': 768,
};

// Per-model character truncation limits. Sized from each model's native context.
// Dense content (names, URLs, technical terms) tokenizes at ~2-3 chars/token
// rather than the typical 4; limits below assume dense content and leave a
// safety margin. Override with `maxChars` constructor arg for custom modelfiles
// that extend num_ctx.
const KNOWN_MAX_CHARS: Record<string, number> = {
  'nomic-embed-text': 4800,       // 2048 token context
  'mxbai-embed-large': 1200,      // 512 token context (dense-content safe)
  'snowflake-arctic-embed': 1200, // 512 token context
  'snowflake-arctic-embed2': 4800, // 8192 but default 2048
  'bge-m3': 4800,                 // 8192 token context
  'bge-large': 1200,              // 512 token context
  'all-minilm': 600,              // 256 token context
  'embeddinggemma': 4800,         // 2048 token context
};

const CONTEXT_LENGTH_ERROR = /context length|context_length|maximum context/i;

export interface OllamaEmbeddingOptions {
  model: string;
  host?: string;
  dimensions?: number;
  /** Override max input chars per text (useful for extended-context modelfiles). */
  maxChars?: number;
}

interface OllamaEmbedResponse {
  embeddings: number[][];
  model: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  private _dimensions: number;
  private host: string;
  private dimensionsResolved: boolean;
  private maxChars: number;

  constructor(opts: OllamaEmbeddingOptions) {
    this.modelName = opts.model;
    this.host = (opts.host ?? DEFAULT_HOST).replace(/\/$/, '');

    const baseModel = opts.model.split(':')[0];
    const known = opts.dimensions ?? KNOWN_DIMENSIONS[baseModel];
    if (known) {
      this._dimensions = known;
      this.dimensionsResolved = true;
    } else {
      this._dimensions = 0;
      this.dimensionsResolved = false;
    }

    this.maxChars = opts.maxChars ?? KNOWN_MAX_CHARS[baseModel] ?? DEFAULT_MAX_CHARS;
  }

  get dimensions(): number {
    if (!this.dimensionsResolved) {
      throw new Error(
        `Ollama model "${this.modelName}" has unknown embedding dimensions. ` +
        `Set GBRAIN_EMBEDDING_DIMENSIONS or call embedBatch() first to probe.`,
      );
    }
    return this._dimensions;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const truncated = texts.map(t => t.slice(0, this.maxChars));
    const result = await this.callOllamaWithRetry(truncated, this.maxChars);

    if (!this.dimensionsResolved && result.length > 0) {
      this._dimensions = result[0].length;
      this.dimensionsResolved = true;
    }

    return result;
  }

  private async callOllamaWithRetry(
    texts: string[],
    currentMaxChars: number,
  ): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.callOllama(texts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);

        // Adaptive truncation: halve inputs and retry when the model's context
        // window is smaller than our char budget (happens on dense content).
        if (CONTEXT_LENGTH_ERROR.test(msg) && currentMaxChars > 200) {
          const next = Math.floor(currentMaxChars / 2);
          const halved = texts.map(t => t.slice(0, next));
          return this.callOllamaWithRetry(halved, next);
        }

        if (attempt === MAX_RETRIES - 1) throw e;
        await sleep(exponentialDelay(attempt));
      }
    }
    throw new Error('Ollama embedding failed after all retries');
  }

  private async callOllama(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(`${this.host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelName, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama /api/embed failed: ${response.status} ${body}`);
    }

    const data = await response.json() as OllamaEmbedResponse;
    if (!Array.isArray(data.embeddings)) {
      throw new Error(`Ollama /api/embed returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
    }

    return data.embeddings.map(arr => new Float32Array(arr));
  }
}

function exponentialDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
