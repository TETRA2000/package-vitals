import { describe, it, expect } from 'vitest';
import { codeSpan, escapeCell, formatChange, formatCount, formatDate, formatPlural, formatTimestamp }
  from '../../../src/core/reports/markdown.js';

describe('escapeCell', () => {
  it('escapes pipes', () => expect(escapeCell('a|b')).toBe('a\\|b'));
  it('collapses line breaks and whitespace runs', () => {
    expect(escapeCell('x\n  y')).toBe('x y');
    expect(escapeCell(' a\r\n\tb c ')).toBe('a b c');
  });
  it('turns HTML into text', () => expect(escapeCell('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;'));
  it('escapes ampersands', () => expect(escapeCell('A & B')).toBe('A &amp; B'));
  it('neutralises Markdown links, images, and code spans', () => {
    expect(escapeCell('![x](https://evil.example/p.png) [click](javascript:alert(1)) `code`'))
      .toBe('!\\[x\\](https://evil.example/p.png) \\[click\\](javascript:alert(1)) \\`code\\`');
  });
  it('escapes backslashes so they cannot cancel an escape', () => {
    expect(escapeCell('a\\|b \\[x](u)')).toBe('a\\\\\\|b \\\\\\[x\\](u)');
  });
  it('keeps emphasis and strikethrough characters literal', () => {
    expect(escapeCell('via `_.unset` and `_.omit`, the __proto__ key, *a* ~~b~~'))
      .toBe('via \\`\\_.unset\\` and \\`\\_.omit\\`, the \\_\\_proto\\_\\_ key, \\*a\\* \\~\\~b\\~\\~');
  });
  it('leaves underscores between letters or digits unescaped', () => {
    expect(escapeCell('tolerable_risk segment__ops v1_2 名前_一覧')).toBe('tolerable_risk segment__ops v1_2 名前_一覧');
  });
});

describe('codeSpan', () => {
  it('wraps text in backticks without escaping it', () => expect(codeSpan('TETRA2000/__init__')).toBe('`TETRA2000/__init__`'));
  it('uses a longer fence than any backtick run inside', () => expect(codeSpan('a`b``c')).toBe('```a`b``c```'));
  it('pads text that starts or ends with a backtick', () => expect(codeSpan('`x')).toBe('`` `x ``'));
  it('collapses line breaks', () => expect(codeSpan('a\n b')).toBe('`a b`'));
});

describe('formatting', () => {
  it('formatCount groups thousands', () => expect(formatCount(10007)).toBe('10,007'));
  it('formatChange', () => {
    expect(formatChange(3)).toBe('+3');
    expect(formatChange(-2)).toBe('-2');
    expect(formatChange(0)).toBe('0');
    expect(formatChange(null)).toBe('n/a');
    expect(formatChange(1234)).toBe('+1,234');
  });
  it('formatPlural', () => {
    expect(formatPlural(1, 'repo')).toBe('1 repo');
    expect(formatPlural(126, 'repo')).toBe('126 repos');
    expect(formatPlural(10007, 'repo')).toBe('10,007 repos');
    expect(formatPlural(0, 'repo')).toBe('0 repos');
  });
  it('formatTimestamp is UTC to the minute', () => {
    expect(formatTimestamp('2026-10-24T05:07:09Z')).toBe('2026-10-24 05:07');
    expect(formatTimestamp('2026-10-24T08:07:09+09:00')).toBe('2026-10-23 23:07');
  });
  it('formatDate', () => {
    expect(formatDate('2022-03-18T00:00:00Z')).toBe('2022-03-18');
    expect(formatDate(null)).toBe('—');
  });
});
