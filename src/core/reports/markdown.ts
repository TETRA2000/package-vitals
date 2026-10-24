/**
 * Makes repo-derived text safe for one Markdown table cell or line: HTML
 * comes out as text, links, images, code spans, and emphasis stay literal,
 * pipes can't split a table row, and line breaks can't end one.
 */
export function escapeCell(text: string): string {
  return text
    .replace(/[\\`*~[\]]/g, '\\$&')
    // An underscore run between two letters or digits can't open or close emphasis, so `tolerable_risk` stays readable.
    .replace(/_+/g, (run: string, i: number, s: string) =>
      WORD_CHAR.test(s[i - 1] ?? '') && WORD_CHAR.test(s[i + run.length] ?? '') ? run : run.replace(/_/g, '\\_'))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORD_CHAR = /^[\p{L}\p{N}]$/u;

/** Repo-derived text as an inline code span, shown exactly as is apart from line breaks. Not for table cells. */
export function codeSpan(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const fence = '`'.repeat(Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatChange(n: number | null): string {
  if (n === null) return 'n/a';
  if (n > 0) return `+${formatCount(n)}`;
  if (n < 0) return `-${formatCount(-n)}`;
  return '0';
}

/** `YYYY-MM-DD` in UTC, or `—` when there is no date. */
export function formatDate(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeCell(iso) : d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD HH:MM` in UTC. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeCell(iso) : d.toISOString().slice(0, 16).replace('T', ' ');
}

/** `1 repo`, `2 repos`, `10,007 repos`. */
export function formatPlural(n: number, word: string): string {
  return `${formatCount(n)} ${n === 1 ? word : `${word}s`}`;
}
