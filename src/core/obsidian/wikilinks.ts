/**
 * Obsidian wikilink parser + slug resolver.
 *
 * Handles three forms:
 *   [[page]]              → { target: "page", alias: null }
 *   [[page|alias]]        → { target: "page", alias: "alias" }
 *   [[path/page]]         → { target: "path/page", alias: null }
 *   [[page#heading]]      → { target: "page", alias: null, heading: "heading" }
 *   [[page#heading|text]] → { target: "page", alias: "text", heading: "heading" }
 *
 * Image/embed links (![[file.png]]) are detected and returned separately so
 * callers can skip them — those are attachments, not page-to-page links.
 */

export interface Wikilink {
  /** The raw target text between the brackets, before the pipe. */
  target: string;
  /** Display alias when `[[target|alias]]` form is used. */
  alias: string | null;
  /** Heading anchor when `[[target#heading]]` form is used. */
  heading: string | null;
  /** True when the link was `![[...]]` (embed/attachment), not a page link. */
  isEmbed: boolean;
  /** 0-based offset in the original content for deduping / context extraction. */
  offset: number;
}

const WIKILINK_PATTERN = /(!)?\[\[([^\]\n]+?)\]\]/g;

/** Extract every `[[...]]` and `![[...]]` occurrence from markdown content. */
export function extractWikilinks(content: string): Wikilink[] {
  const results: Wikilink[] = [];
  // Strip code fences so `[[foo]]` inside ``` blocks isn't treated as a link.
  const stripped = stripCodeBlocks(content);
  let match: RegExpExecArray | null;
  WIKILINK_PATTERN.lastIndex = 0;
  while ((match = WIKILINK_PATTERN.exec(stripped)) !== null) {
    const isEmbed = match[1] === '!';
    const inner = match[2].trim();
    if (!inner) continue;

    // Parse [target#heading|alias] — alias is after the LAST pipe.
    let target = inner;
    let alias: string | null = null;
    let heading: string | null = null;

    const pipeIdx = inner.indexOf('|');
    if (pipeIdx >= 0) {
      target = inner.slice(0, pipeIdx).trim();
      alias = inner.slice(pipeIdx + 1).trim() || null;
    }

    const hashIdx = target.indexOf('#');
    if (hashIdx >= 0) {
      heading = target.slice(hashIdx + 1).trim() || null;
      target = target.slice(0, hashIdx).trim();
    }

    if (!target) continue;
    results.push({ target, alias, heading, isEmbed, offset: match.index });
  }
  return results;
}

/** Replace fenced code blocks with equivalent-length whitespace so offsets stay stable. */
function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));
}

/**
 * Slugify a wikilink target using Obsidian's general convention:
 * lowercase, spaces → hyphens, trim non-slug characters at edges.
 * Keeps slashes (path separators) intact.
 */
export function slugifyWikilinkTarget(target: string): string {
  return target
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-/]+/g, '')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve a wikilink target against the set of known slugs in the brain.
 *
 * Resolution order (first match wins):
 *   1. Exact slug match
 *   2. Exact slug match after slugifying (for `[[Max Levin]]` → `max-levin`)
 *   3. Slug ending in `/<target>` — shortest match (closest to root)
 *   4. Slug whose last path segment equals `<target>` case-insensitively
 *
 * Returns null when no page matches — caller decides whether to skip or warn.
 */
export function resolveWikilink(target: string, allSlugs: Set<string>): string | null {
  if (allSlugs.has(target)) return target;

  const slugified = slugifyWikilinkTarget(target);
  if (slugified && allSlugs.has(slugified)) return slugified;

  const candidates: string[] = [];
  const suffix = `/${slugified || target}`;
  const segmentLower = (slugified || target).toLowerCase();

  for (const slug of allSlugs) {
    if (slug.endsWith(suffix)) {
      candidates.push(slug);
      continue;
    }
    const lastSeg = slug.slice(slug.lastIndexOf('/') + 1);
    if (lastSeg.toLowerCase() === segmentLower) {
      candidates.push(slug);
    }
  }

  if (candidates.length === 0) return null;
  // Prefer the shortest slug — fewest path segments, closest to the vault root.
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}
