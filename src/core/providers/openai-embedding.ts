/**
 * OpenAI embedding provider.
 * Wraps the original embedding_service.rb port: text-embedding-3-large @ 1536d,
 * batch-of-100, exponential backoff with Retry-After honoring.
 */

import OpenAI from 'openai';
import type { EmbeddingProvider } from './types.ts';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

export interface OpenAIEmbeddingOptions {
  model?: string;
  dimensions?: number;
  apiKey?: string;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  private client: OpenAI | null = null;
  private apiKey?: string;

  constructor(opts: OpenAIEmbeddingOptions = {}) {
    this.modelName = opts.model ?? 'text-embedding-3-large';
    this.dimensions = opts.dimensions ?? 1536;
    this.apiKey = opts.apiKey;
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = this.apiKey ? new OpenAI({ apiKey: this.apiKey }) : new OpenAI();
    }
    return this.client;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const truncated = texts.map(t => t.slice(0, MAX_CHARS));
    const results: Float32Array[] = [];

    for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
      const batch = truncated.slice(i, i + BATCH_SIZE);
      const batchResults = await this.embedBatchWithRetry(batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.getClient().embeddings.create({
          model: this.modelName,
          input: texts,
          dimensions: this.dimensions,
        });

        const sorted = response.data.sort((a, b) => a.index - b.index);
        return sorted.map(d => new Float32Array(d.embedding));
      } catch (e: unknown) {
        if (attempt === MAX_RETRIES - 1) throw e;

        let delay = exponentialDelay(attempt);
        if (e instanceof OpenAI.APIError && e.status === 429) {
          const retryAfter = e.headers?.['retry-after'];
          if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed)) delay = parsed * 1000;
          }
        }
        await sleep(delay);
      }
    }
    throw new Error('Embedding failed after all retries');
  }
}

function exponentialDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
