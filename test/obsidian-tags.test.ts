import { describe, test, expect } from 'bun:test';
import { extractBodyTags } from '../src/core/obsidian/tags.ts';

describe('extractBodyTags', () => {
  test('extracts simple #tag', () => {
    expect(extractBodyTags('This is #important to read')).toEqual(['important']);
  });

  test('extracts nested #project/urgent', () => {
    expect(extractBodyTags('Filed under #project/urgent today')).toEqual(['project/urgent']);
  });

  test('dedupes repeated tags', () => {
    const tags = extractBodyTags('#foo then #foo again and #foo once more');
    expect(tags).toEqual(['foo']);
  });

  test('lowercases tag text', () => {
    expect(extractBodyTags('Tagged #URGENT')).toEqual(['urgent']);
  });

  test('ignores markdown headings (# Heading, ## Heading)', () => {
    const content = '# My heading\n## Sub\nbody with #real-tag here';
    expect(extractBodyTags(content)).toEqual(['real-tag']);
  });

  test('ignores tags inside fenced code blocks', () => {
    const content = 'Real #tag1\n```\nfake #nottag in code\n```\nAnother #tag2';
    expect(extractBodyTags(content).sort()).toEqual(['tag1', 'tag2']);
  });

  test('ignores tags inside inline code', () => {
    const content = 'Use `#ffffff` for white. But tag #design is real.';
    expect(extractBodyTags(content)).toEqual(['design']);
  });

  test('ignores hex color shorthands (#fff, #abc123)', () => {
    expect(extractBodyTags('color: #fff; other: #a1b2c3;')).toEqual([]);
  });

  test('ignores URL fragments', () => {
    expect(extractBodyTags('https://example.com/docs#section-1 is a link')).toEqual([]);
  });

  test('ignores purely numeric tags like #1', () => {
    expect(extractBodyTags('Item #1, then #real-item')).toEqual(['real-item']);
  });

  test('accepts underscores and hyphens in tag body', () => {
    expect(extractBodyTags('A #snake_case tag and a #kebab-case tag')).toEqual(['snake_case', 'kebab-case']);
  });

  test('empty content returns empty array', () => {
    expect(extractBodyTags('')).toEqual([]);
  });

  test('extracts multiple tags across paragraphs', () => {
    const content = 'First paragraph with #alpha.\n\nSecond with #beta and #gamma.';
    expect(extractBodyTags(content).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
});
