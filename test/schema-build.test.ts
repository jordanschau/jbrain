import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  buildPostgresSchema,
  buildPGLiteSchema,
  substituteSchema,
} from '../src/core/schema-build.ts';
import { resetProviders } from '../src/core/providers/factory.ts';

const ENV_KEYS = [
  'GBRAIN_EMBEDDING_PROVIDER',
  'GBRAIN_EMBEDDING_MODEL',
  'GBRAIN_EMBEDDING_DIMENSIONS',
  'OLLAMA_HOST',
];

let saved: Record<string, string | undefined>;

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

describe('schema templating', () => {
  test('substituteSchema replaces both placeholders globally', () => {
    const tpl = `vector(__EMBEDDING_DIMENSIONS__) DEFAULT '__EMBEDDING_MODEL__'
also: vector(__EMBEDDING_DIMENSIONS__)`;
    const out = substituteSchema(tpl, 768, 'nomic-embed-text');
    expect(out).toBe(`vector(768) DEFAULT 'nomic-embed-text'
also: vector(768)`);
  });

  test('buildPostgresSchema defaults to OpenAI 1536d', () => {
    const sql = buildPostgresSchema();
    expect(sql).toContain('vector(1536)');
    expect(sql).toContain("'text-embedding-3-large'");
    expect(sql).not.toContain('__EMBEDDING_DIMENSIONS__');
    expect(sql).not.toContain('__EMBEDDING_MODEL__');
  });

  test('buildPGLiteSchema defaults to OpenAI 1536d', () => {
    const sql = buildPGLiteSchema();
    expect(sql).toContain('vector(1536)');
    expect(sql).not.toContain('__EMBEDDING_DIMENSIONS__');
  });

  test('buildPostgresSchema honors Ollama provider via env', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'nomic-embed-text';
    const sql = buildPostgresSchema();
    expect(sql).toContain('vector(768)');
    expect(sql).toContain("'nomic-embed-text'");
    expect(sql).not.toContain('vector(1536)');
  });

  test('buildPGLiteSchema honors mxbai-embed-large dimensions', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'mxbai-embed-large';
    const sql = buildPGLiteSchema();
    expect(sql).toContain('vector(1024)');
    expect(sql).toContain("'mxbai-embed-large'");
  });

  test('explicit overrides take precedence over provider defaults', () => {
    const sql = buildPostgresSchema({ dimensions: 256, model: 'custom' });
    expect(sql).toContain('vector(256)');
    expect(sql).toContain("'custom'");
  });

  test('config table INSERT also gets substituted', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBEDDING_MODEL = 'bge-m3';
    const sql = buildPGLiteSchema();
    // The config INSERT statement should reflect the active provider
    expect(sql).toMatch(/'embedding_dimensions',\s*'1024'/);
    expect(sql).toMatch(/'embedding_model',\s*'bge-m3'/);
  });
});
