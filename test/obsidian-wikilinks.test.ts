import { describe, test, expect } from 'bun:test';
import {
  extractWikilinks,
  resolveWikilink,
  slugifyWikilinkTarget,
} from '../src/core/obsidian/wikilinks.ts';

describe('extractWikilinks', () => {
  test('extracts bare [[target]]', () => {
    const links = extractWikilinks('See [[max-levin]] for context.');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ target: 'max-levin', alias: null, heading: null, isEmbed: false });
  });

  test('extracts [[target|alias]]', () => {
    const links = extractWikilinks('We met [[faraz-ghadooshahy|Faraz]] yesterday.');
    expect(links[0].target).toBe('faraz-ghadooshahy');
    expect(links[0].alias).toBe('Faraz');
  });

  test('extracts [[target#heading]]', () => {
    const links = extractWikilinks('See [[proposal#timeline]] section.');
    expect(links[0].target).toBe('proposal');
    expect(links[0].heading).toBe('timeline');
  });

  test('extracts [[target#heading|alias]]', () => {
    const links = extractWikilinks('See [[proposal#timeline|the timeline]].');
    expect(links[0].target).toBe('proposal');
    expect(links[0].heading).toBe('timeline');
    expect(links[0].alias).toBe('the timeline');
  });

  test('marks ![[image.png]] as embed', () => {
    const links = extractWikilinks('Screenshot: ![[IMG_7599.heic]]');
    expect(links[0].isEmbed).toBe(true);
    expect(links[0].target).toBe('IMG_7599.heic');
  });

  test('handles path-qualified targets [[ffc/people/max-levin]]', () => {
    const links = extractWikilinks('cf. [[ffc/wiki/people/max-levin]]');
    expect(links[0].target).toBe('ffc/wiki/people/max-levin');
  });

  test('finds multiple wikilinks in one document', () => {
    const content = 'Meeting with [[max-levin]] and [[boca-gas]] about [[deal-xyz]].';
    const links = extractWikilinks(content);
    expect(links).toHaveLength(3);
    expect(links.map(l => l.target)).toEqual(['max-levin', 'boca-gas', 'deal-xyz']);
  });

  test('ignores wikilinks inside fenced code blocks', () => {
    const content = 'Real: [[real-page]]\n```\ncode with [[fake-link]]\n```\nMore real: [[other]]';
    const links = extractWikilinks(content);
    expect(links.map(l => l.target)).toEqual(['real-page', 'other']);
  });

  test('ignores empty brackets and whitespace-only targets', () => {
    const links = extractWikilinks('Bad: [[]] and [[   ]] but [[good]]');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('good');
  });

  test('tracks offsets', () => {
    const content = 'prefix [[a]] more [[b]]';
    const links = extractWikilinks(content);
    expect(links[0].offset).toBe(7);
    expect(links[1].offset).toBe(18);
  });
});

describe('slugifyWikilinkTarget', () => {
  test('lowercases and replaces spaces with hyphens', () => {
    expect(slugifyWikilinkTarget('Max Levin')).toBe('max-levin');
  });

  test('preserves path separators', () => {
    expect(slugifyWikilinkTarget('People/Max Levin')).toBe('people/max-levin');
  });

  test('strips punctuation', () => {
    expect(slugifyWikilinkTarget("Faraz's Notes!")).toBe('farazs-notes');
  });

  test('already-slug input is idempotent', () => {
    expect(slugifyWikilinkTarget('max-levin')).toBe('max-levin');
  });
});

describe('resolveWikilink', () => {
  const slugs = new Set([
    'ffc/wiki/people/max-levin',
    'ffc/wiki/people/faraz-ghadooshahy',
    'ffc/wiki/boca-gas',
    'jbi/wiki/boca-gas',
    'max-levin',
    'ffc/wiki/deals/deal-xyz',
  ]);

  test('exact slug match wins', () => {
    expect(resolveWikilink('max-levin', slugs)).toBe('max-levin');
  });

  test('suffix match resolves short form to deep path', () => {
    const slugs2 = new Set(['ffc/wiki/people/max-levin', 'jbi/wiki/notes']);
    expect(resolveWikilink('max-levin', slugs2)).toBe('ffc/wiki/people/max-levin');
  });

  test('disambiguates multiple suffix matches by shortest slug', () => {
    // boca-gas exists in both ffc/wiki/ and jbi/wiki/ — shortest path wins
    expect(resolveWikilink('boca-gas', slugs)).toBe('ffc/wiki/boca-gas');
  });

  test('resolves human-readable names via slugification', () => {
    expect(resolveWikilink('Max Levin', slugs)).toBe('max-levin');
  });

  test('resolves path-qualified target exactly', () => {
    expect(resolveWikilink('ffc/wiki/deals/deal-xyz', slugs)).toBe('ffc/wiki/deals/deal-xyz');
  });

  test('returns null when no match exists', () => {
    expect(resolveWikilink('who-is-this', slugs)).toBeNull();
  });

  test('case-insensitive last-segment fallback', () => {
    const slugs2 = new Set(['people/JaneDoe']);
    // "janedoe" lowercased matches "janedoe" (lastSegment lowered)
    expect(resolveWikilink('janedoe', slugs2)).toBe('people/JaneDoe');
  });
});
