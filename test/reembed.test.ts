import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

const ENV_KEYS = [
  'GBRAIN_EMBEDDING_PROVIDER',
  'GBRAIN_EMBEDDING_MODEL',
  'GBRAIN_EMBEDDING_DIMENSIONS',
  'OLLAMA_HOST',
];

let saved: Record<string, string | undefined>;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(768)),
}));

const { runReembed } = await import('../src/commands/reembed.ts');
const { resetProviders } = await import('../src/core/providers/factory.ts');

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

interface MockState {
  config: Record<string, string>;
  migrations: string[];
  setConfigCalls: Array<[string, string]>;
}

function mockEngine(initial: Record<string, string>): { engine: BrainEngine; state: MockState } {
  const state: MockState = {
    config: { ...initial },
    migrations: [],
    setConfigCalls: [],
  };
  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      switch (prop) {
        case 'getConfig':
          return async (k: string) => state.config[k] ?? null;
        case 'setConfig':
          return async (k: string, v: string) => {
            state.config[k] = v;
            state.setConfigCalls.push([k, v]);
          };
        case 'runMigration':
          return async (_v: number, sql: string) => { state.migrations.push(sql); };
        case 'listPages':
          return async () => [];
        default:
          return async () => null;
      }
    },
  }) as BrainEngine;
  return { engine, state };
}

describe('runReembed', () => {
  test('skips DDL when dimensions match', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'nomic-embed-text';
    const { engine, state } = mockEngine({
      embedding_dimensions: '768',
      embedding_model: 'nomic-embed-text',
    });

    await runReembed(engine, []);

    expect(state.migrations).toEqual([]);
  });

  test('runs ALTER TABLE when dimensions differ (1536 → 768)', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'nomic-embed-text';
    const { engine, state } = mockEngine({
      embedding_dimensions: '1536',
      embedding_model: 'text-embedding-3-large',
    });

    await runReembed(engine, []);

    expect(state.migrations.length).toBeGreaterThanOrEqual(2);
    const ddl = state.migrations.join('\n');
    expect(ddl).toContain('DROP INDEX IF EXISTS idx_chunks_embedding');
    expect(ddl).toContain('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding');
    expect(ddl).toContain('ADD COLUMN embedding vector(768)');
    expect(ddl).toContain('UPDATE content_chunks SET embedded_at = NULL');
    expect(state.config.embedding_dimensions).toBe('768');
    expect(state.config.embedding_model).toBe('nomic-embed-text');
  });

  test('--dry-run skips DDL and config writes', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'nomic-embed-text';
    const { engine, state } = mockEngine({
      embedding_dimensions: '1536',
      embedding_model: 'text-embedding-3-large',
    });

    await runReembed(engine, ['--dry-run']);

    expect(state.migrations).toEqual([]);
    expect(state.setConfigCalls).toEqual([]);
  });

  test('--force rebuilds even when dimensions match', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'nomic-embed-text';
    const { engine, state } = mockEngine({
      embedding_dimensions: '768',
      embedding_model: 'nomic-embed-text',
    });

    await runReembed(engine, ['--force']);

    expect(state.migrations.length).toBeGreaterThanOrEqual(2);
  });

  test('escapes single quotes in model name', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = "weird'name";
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '512';
    const { engine, state } = mockEngine({
      embedding_dimensions: '1536',
      embedding_model: 'old',
    });

    await runReembed(engine, []);

    const updateSql = state.migrations.find(m => m.includes('UPDATE content_chunks'));
    expect(updateSql).toContain("'weird''name'");
  });
});
