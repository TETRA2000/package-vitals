import { formatTimestamp } from '../../core/reports/markdown.js';

/** Whole UTC calendar months between two dates, as `under a month`, `N months`, or `N years`. */
export function formatAge(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  if (months < 1) return 'under a month';
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'}`;
  const years = Math.floor(months / 12);
  return `${years} ${years === 1 ? 'year' : 'years'}`;
}

export function formatUtc(iso: string): string {
  return `${formatTimestamp(iso)} UTC`;
}

/** The message of an error from `ipcRenderer.invoke`, without Electron's wrapper or the error class name. */
export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/^Error invoking remote method '[^']*': /, '')
    .replace(/^(?:IpcInputError|Error): /, '');
}
