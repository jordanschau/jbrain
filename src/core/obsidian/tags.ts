/**
 * Obsidian body-tag extractor.
 *
 * Obsidian recognizes #tag tokens embedded in note body text (distinct from
 * frontmatter `tags:` which the markdown parser already handles). Supports
 * nested tags like #project/urgent and excludes false positives: markdown
 * headings (#, ##, ###), URL fragments (https://x.com/#section), hex colors
 * (#fff, #abc123), and anything inside fenced code blocks or inline code.
 */

// Allowed tag characters per Obsidian: letters, digits, underscore, hyphen,
// forward slash (nested tags), and Unicode word chars. Must NOT start with a digit.
const TAG_PATTERN = /(^|[^\w#/])(#[A-Za-z_][\w\-/]*)/g;

// Hex color shorthand/full (#fff, #abc123). Tags cannot be entirely hex.
const HEX_COLOR = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/;

/** Extract `#tag` occurrences from markdown body. Returns deduplicated slugs without the leading #. */
export function extractBodyTags(content: string): string[] {
  const stripped = stripCodeAndHeadings(content);
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  TAG_PATTERN.lastIndex = 0;
  while ((match = TAG_PATTERN.exec(stripped)) !== null) {
    const raw = match[2];
    if (HEX_COLOR.test(raw)) continue;
    const tag = raw.slice(1).toLowerCase();
    if (!tag) continue;
    // Obsidian rejects purely-numeric tags (#123 is treated as text).
    if (/^\d+$/.test(tag)) continue;
    seen.add(tag);
  }

  return [...seen];
}

/**
 * Strip fenced code blocks, inline code spans, and markdown headings.
 * Preserves length so offsets match the original content.
 */
function stripCodeAndHeadings(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, m => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
    .replace(/^#{1,6}\s.*$/gm, m => ' '.repeat(m.length));
}
