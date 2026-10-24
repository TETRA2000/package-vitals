import { parseArgs } from 'node:util';
import type { FetchLike } from '../core/github/client.js';
import { GitHubApiError } from '../core/github/client.js';
import { ToolError, type ExecLike } from '../core/github/token.js';
import { checkupCommand } from './commands/checkup.js';
import { reportCommand } from './commands/report.js';

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  /** Writes one line to stdout. */
  stdout: (s: string) => void;
  /** Writes one line to stderr. */
  stderr: (s: string) => void;
  fetch: FetchLike;
  exec: ExecLike;
  now: () => Date;
}

export const USAGE = `Usage:
  package-vitals checkup [--include-forks] [--include-archived] [--concurrency N]
  package-vitals report account [--snapshot N]
  package-vitals report repo <owner/name> [--snapshot N]`;

class UsageError extends Error {}

/** Runs the CLI and returns its exit code: 0 for success, 1 for an error, 2 for a usage error. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  try {
    const [command, ...args] = argv;
    if (command === 'checkup') return await checkupCommand(parseCheckup(args), deps);
    if (command === 'report') return await reportCommand(parseReport(args), deps);
    throw new UsageError(command === undefined ? '' : `Unknown command: ${command}`);
  } catch (err) {
    if (err instanceof UsageError) {
      if (err.message) deps.stderr(err.message);
      deps.stderr(USAGE);
      return 2;
    }
    if (err instanceof ToolError || err instanceof GitHubApiError) {
      deps.stderr(err.message);
      return 1;
    }
    deps.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** Turns parseArgs errors (unknown option, missing value) into usage errors. */
function usage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function integer(value: string, flag: string, min: number, max?: number): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < min || n > (max ?? Number.MAX_SAFE_INTEGER)) {
    throw new UsageError(max === undefined
      ? `${flag} must be a whole number of at least ${min}.`
      : `${flag} must be an integer from ${min} to ${max}.`);
  }
  return n;
}

function parseCheckup(args: string[]) {
  const { values, positionals } = usage(() => parseArgs({
    args,
    options: {
      'include-forks': { type: 'boolean' },
      'include-archived': { type: 'boolean' },
      concurrency: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  }));
  if (positionals.length > 0) throw new UsageError(`Unexpected argument: ${positionals[0]}`);
  return {
    includeForks: values['include-forks'] === true,
    includeArchived: values['include-archived'] === true,
    concurrency: values.concurrency === undefined ? 8 : integer(values.concurrency, '--concurrency', 1, 32),
  };
}

function parseReport(args: string[]) {
  const { values, positionals } = usage(() => parseArgs({
    args,
    options: { snapshot: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  }));
  const snapshot = values.snapshot === undefined
    ? undefined
    : integer(values.snapshot, '--snapshot', 1);
  const [kind, ...rest] = positionals;
  if (kind === 'account' && rest.length === 0) return { kind, snapshot } as const;
  if (kind === 'repo' && rest.length === 1 && /^[^/\s]+\/[^/\s]+$/.test(rest[0]!)) {
    return { kind, fullName: rest[0]!, snapshot } as const;
  }
  throw new UsageError('');
}
