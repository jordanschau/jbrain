/**
 * Vault-backed write path.
 *
 * When GBrainConfig.vault_path is set, put_page / delete_page mirror their
 * writes to the markdown file inside the vault. The watch loop
 * (`gbrain obsidian --watch`) then detects the change and re-ingests, but the
 * brain state has already been updated through the same transaction. This is
 * the bridge that lets agents (via MCP) maintain the living wiki: write once
 * through put_page, both brain and vault stay in sync.
 *
 * Conventions:
 *   - slug "ffc/wiki/people/faraz" → vault file "<vault>/ffc/wiki/people/faraz.md"
 *   - parent directories are created as needed
 *   - content is serialized via src/core/markdown.ts serializeMarkdown()
 */

import { writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import type { PageInput } from './types.ts';
import { serializeMarkdown } from './markdown.ts';

export interface VaultWriteInput extends PageInput {
  tags?: string[];
}

/**
 * Write a page to the vault as markdown. Returns the absolute file path written,
 * or null if the vault path isn't set or the resolved path would escape the vault.
 */
export async function writePageToVault(
  vaultPath: string | undefined,
  slug: string,
  page: VaultWriteInput,
): Promise<string | null> {
  if (!vaultPath) return null;

  const absPath = resolveVaultFile(vaultPath, slug);
  if (!absPath) return null;

  await mkdir(dirname(absPath), { recursive: true });

  const markdown = serializeMarkdown(
    page.frontmatter ?? {},
    page.compiled_truth,
    page.timeline ?? '',
    { type: page.type, title: page.title, tags: page.tags ?? [] },
  );
  await writeFile(absPath, markdown, 'utf-8');
  return absPath;
}

/**
 * Delete a page's vault file. Silent no-op when the vault path isn't set or
 * the file doesn't exist.
 */
export async function deletePageFromVault(
  vaultPath: string | undefined,
  slug: string,
): Promise<string | null> {
  if (!vaultPath) return null;
  const absPath = resolveVaultFile(vaultPath, slug);
  if (!absPath) return null;
  if (!existsSync(absPath)) return null;
  await unlink(absPath);
  return absPath;
}

/**
 * Resolve a slug to an absolute path inside the vault. Returns null when the
 * resolved path would escape the vault root (defense against path traversal
 * via slug like `../../etc/passwd`).
 */
export function resolveVaultFile(vaultPath: string, slug: string): string | null {
  if (!slug) return null;
  // Reject absolute slugs outright — they bypass the vault root via path.join()
  // dropping the leading separator. Legitimate brain slugs are always relative.
  if (slug.startsWith('/') || slug.startsWith('\\')) return null;
  const vaultRoot = resolve(vaultPath);
  const candidate = resolve(join(vaultRoot, `${slug}.md`));
  const rel = relative(vaultRoot, candidate);
  if (rel.startsWith('..') || resolve(vaultRoot, rel) !== candidate) return null;
  return candidate;
}
