import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import {
  writePageToVault,
  deletePageFromVault,
  resolveVaultFile,
} from '../src/core/vault-writer.ts';

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'jbrain-vault-writer-'));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

describe('resolveVaultFile', () => {
  test('resolves simple slug to absolute path', () => {
    const p = resolveVaultFile(vault, 'notes/hello');
    expect(p).toBe(join(vault, 'notes/hello.md'));
  });

  test('rejects traversal via ..', () => {
    expect(resolveVaultFile(vault, '../escape')).toBeNull();
    expect(resolveVaultFile(vault, 'notes/../../escape')).toBeNull();
  });

  test('rejects absolute slugs', () => {
    expect(resolveVaultFile(vault, '/etc/passwd')).toBeNull();
  });

  test('rejects empty slug', () => {
    expect(resolveVaultFile(vault, '')).toBeNull();
  });

  test('handles deeply nested slugs', () => {
    const p = resolveVaultFile(vault, 'ffc/wiki/people/faraz');
    expect(p).toBe(join(vault, 'ffc/wiki/people/faraz.md'));
  });
});

describe('writePageToVault', () => {
  test('returns null when vault_path is undefined', async () => {
    const result = await writePageToVault(undefined, 'slug', {
      type: 'concept', title: 'x', compiled_truth: 'body',
    });
    expect(result).toBeNull();
  });

  test('writes markdown with frontmatter + body', async () => {
    const result = await writePageToVault(vault, 'notes/hello', {
      type: 'concept',
      title: 'Hello',
      compiled_truth: 'This is the body.',
      tags: ['alpha', 'beta'],
    });

    expect(result).toBe(join(vault, 'notes/hello.md'));
    const content = readFileSync(result!, 'utf-8');
    expect(content).toContain("type: concept");
    expect(content).toContain('title: Hello');
    expect(content).toContain('alpha');
    expect(content).toContain('beta');
    expect(content).toContain('This is the body.');
  });

  test('serializes compiled_truth + --- + timeline', async () => {
    const result = await writePageToVault(vault, 'p', {
      type: 'person',
      title: 'P',
      compiled_truth: 'state',
      timeline: '- 2026-04-17 | first contact',
    });
    const content = readFileSync(result!, 'utf-8');
    expect(content).toContain('state');
    expect(content).toContain('---');
    expect(content).toContain('2026-04-17');
  });

  test('creates parent directories as needed', async () => {
    const slug = 'a/b/c/d/deep';
    const result = await writePageToVault(vault, slug, {
      type: 'concept', title: 't', compiled_truth: 'x',
    });
    expect(existsSync(result!)).toBe(true);
    expect(result).toBe(join(vault, 'a/b/c/d/deep.md'));
  });

  test('overwrites existing file', async () => {
    mkdirSync(join(vault, 'notes'), { recursive: true });
    writeFileSync(join(vault, 'notes/hello.md'), 'OLD', 'utf-8');

    await writePageToVault(vault, 'notes/hello', {
      type: 'concept', title: 'Hello', compiled_truth: 'NEW',
    });
    expect(readFileSync(join(vault, 'notes/hello.md'), 'utf-8')).toContain('NEW');
  });

  test('refuses to write outside vault', async () => {
    const result = await writePageToVault(vault, '../escape', {
      type: 'concept', title: 'x', compiled_truth: 'y',
    });
    expect(result).toBeNull();
  });
});

describe('deletePageFromVault', () => {
  test('returns null when vault_path is undefined', async () => {
    const result = await deletePageFromVault(undefined, 'slug');
    expect(result).toBeNull();
  });

  test('deletes existing vault file', async () => {
    mkdirSync(join(vault, 'notes'), { recursive: true });
    const filePath = join(vault, 'notes/hello.md');
    writeFileSync(filePath, 'content', 'utf-8');
    expect(existsSync(filePath)).toBe(true);

    const result = await deletePageFromVault(vault, 'notes/hello');
    expect(result).toBe(filePath);
    expect(existsSync(filePath)).toBe(false);
  });

  test('returns null when file does not exist', async () => {
    const result = await deletePageFromVault(vault, 'nonexistent');
    expect(result).toBeNull();
  });

  test('refuses to delete outside vault', async () => {
    const result = await deletePageFromVault(vault, '../escape');
    expect(result).toBeNull();
  });
});
