/**
 * Schema templating: substitute embedding placeholders in the raw schema SQL
 * with values from the active EmbeddingProvider.
 *
 * Placeholders in src/schema.sql and src/core/pglite-schema.ts:
 *   __EMBEDDING_DIMENSIONS__ → e.g. 1536, 768, 1024
 *   __EMBEDDING_MODEL__      → e.g. text-embedding-3-large, nomic-embed-text
 *
 * Resolved at engine.initSchema() time so the same source supports any provider.
 */

import { SCHEMA_SQL } from './schema-embedded.ts';
import { PGLITE_SCHEMA_SQL } from './pglite-schema.ts';
import { getEmbeddingProvider } from './providers/factory.ts';

function substitute(template: string, dimensions: number, model: string): string {
  return template
    .replace(/__EMBEDDING_DIMENSIONS__/g, String(dimensions))
    .replace(/__EMBEDDING_MODEL__/g, model);
}

export function buildPostgresSchema(opts?: { dimensions?: number; model?: string }): string {
  const provider = getEmbeddingProvider();
  return substitute(
    SCHEMA_SQL,
    opts?.dimensions ?? provider.dimensions,
    opts?.model ?? provider.modelName,
  );
}

export function buildPGLiteSchema(opts?: { dimensions?: number; model?: string }): string {
  const provider = getEmbeddingProvider();
  return substitute(
    PGLITE_SCHEMA_SQL,
    opts?.dimensions ?? provider.dimensions,
    opts?.model ?? provider.modelName,
  );
}

/** For tests: substitute with explicit values without touching the provider. */
export function substituteSchema(template: string, dimensions: number, model: string): string {
  return substitute(template, dimensions, model);
}
