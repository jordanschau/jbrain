/**
 * Anthropic chat provider. Wraps the original Claude Haiku call from expansion.ts.
 * Uses tool_use to coerce structured JSON output.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider, CompleteOpts, CompleteJSONOpts } from './types.ts';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicChatOptions {
  model?: string;
  apiKey?: string;
}

export class AnthropicChatProvider implements ChatProvider {
  readonly modelName: string;
  private client: Anthropic | null = null;
  private apiKey?: string;

  constructor(opts: AnthropicChatOptions = {}) {
    this.modelName = opts.model ?? DEFAULT_MODEL;
    this.apiKey = opts.apiKey;
  }

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = this.apiKey ? new Anthropic({ apiKey: this.apiKey }) : new Anthropic();
    }
    return this.client;
  }

  async complete(prompt: string, opts: CompleteOpts = {}): Promise<string> {
    const response = await this.getClient().messages.create({
      model: this.modelName,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature,
      system: opts.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
    return text;
  }

  async completeJSON<T = unknown>(prompt: string, opts: CompleteJSONOpts): Promise<T> {
    const response = await this.getClient().messages.create({
      model: this.modelName,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature,
      system: opts.systemPrompt,
      tools: [{
        name: opts.schemaName,
        description: opts.schemaDescription ?? `Return a structured ${opts.schemaName} response`,
        input_schema: opts.schema as Anthropic.Tool.InputSchema,
      }],
      tool_choice: { type: 'tool', name: opts.schemaName },
      messages: [{ role: 'user', content: prompt }],
    });

    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === opts.schemaName) {
        return block.input as T;
      }
    }

    throw new Error(`Anthropic completeJSON: no tool_use block returned for "${opts.schemaName}"`);
  }
}
