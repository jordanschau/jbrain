/**
 * Ollama chat provider. Calls POST {host}/api/chat with `format: <json schema>`
 * for structured output (Ollama 0.5+).
 */

import type { ChatProvider, CompleteOpts, CompleteJSONOpts } from './types.ts';

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_MAX_TOKENS = 1024;

export interface OllamaChatOptions {
  model?: string;
  host?: string;
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  done?: boolean;
  error?: string;
}

export class OllamaChatProvider implements ChatProvider {
  readonly modelName: string;
  private host: string;

  constructor(opts: OllamaChatOptions = {}) {
    this.modelName = opts.model ?? DEFAULT_MODEL;
    this.host = (opts.host ?? DEFAULT_HOST).replace(/\/$/, '');
  }

  async complete(prompt: string, opts: CompleteOpts = {}): Promise<string> {
    const data = await this.callChat(prompt, opts);
    return data.message?.content ?? '';
  }

  async completeJSON<T = unknown>(prompt: string, opts: CompleteJSONOpts): Promise<T> {
    const data = await this.callChat(prompt, opts, opts.schema);
    const content = data.message?.content ?? '';
    try {
      return JSON.parse(content) as T;
    } catch (e) {
      throw new Error(
        `Ollama completeJSON: model returned non-JSON content for "${opts.schemaName}": ${content.slice(0, 200)}`,
      );
    }
  }

  private async callChat(
    prompt: string,
    opts: CompleteOpts,
    format?: Record<string, unknown>,
  ): Promise<OllamaChatResponse> {
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
      stream: false,
      options: {
        num_predict: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      },
    };
    if (format) body.format = format;

    const response = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama /api/chat failed: ${response.status} ${text}`);
    }

    const data = await response.json() as OllamaChatResponse;
    if (data.error) throw new Error(`Ollama /api/chat error: ${data.error}`);
    return data;
  }
}
