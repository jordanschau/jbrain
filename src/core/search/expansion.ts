/**
 * Multi-Query Expansion via the active ChatProvider.
 *
 * Skip queries < 3 words. Generate 2 alternative phrasings via structured JSON
 * output. Return original + alternatives (max 3 total). Provider-agnostic:
 * defaults to Anthropic Claude Haiku, swappable to Ollama via config.
 */

import { getChatProvider } from '../providers/factory.ts';

const MAX_QUERIES = 3;
const MIN_WORDS = 3;

export async function expandQuery(query: string): Promise<string[]> {
  // CJK text is not space-delimited — count characters instead of whitespace tokens.
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(query);
  const wordCount = hasCJK ? query.replace(/\s/g, '').length : (query.match(/\S+/g) || []).length;
  if (wordCount < MIN_WORDS) return [query];

  try {
    const alternatives = await callProviderForExpansion(query);
    const all = [query, ...alternatives];
    const unique = [...new Set(all.map(q => q.toLowerCase().trim()))];
    return unique.slice(0, MAX_QUERIES).map(q =>
      all.find(orig => orig.toLowerCase().trim() === q) || q,
    );
  } catch {
    return [query];
  }
}

interface ExpansionResult {
  alternative_queries?: unknown;
}

async function callProviderForExpansion(query: string): Promise<string[]> {
  const provider = getChatProvider();
  const result = await provider.completeJSON<ExpansionResult>(
    `Generate 2 alternative search queries that would find relevant results for this question. Each alternative should approach the topic from a different angle or use different terminology.

Original query: "${query}"`,
    {
      schemaName: 'expand_query',
      schemaDescription: 'Generate alternative phrasings of a search query to improve recall',
      maxTokens: 300,
      schema: {
        type: 'object',
        properties: {
          alternative_queries: {
            type: 'array',
            items: { type: 'string' },
            description: '2 alternative phrasings of the original query, each approaching the topic from a different angle',
          },
        },
        required: ['alternative_queries'],
      },
    },
  );

  if (Array.isArray(result.alternative_queries)) {
    return result.alternative_queries.map(String).slice(0, 2);
  }
  return [];
}
