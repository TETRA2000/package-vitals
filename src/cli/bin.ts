#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { main, type CliDeps } from './main.js';

const execFileAsync = promisify(execFile);

const realDeps: CliDeps = {
  env: process.env,
  platform: process.platform,
  homeDir: homedir(),
  stdout: (s) => process.stdout.write(`${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
  fetch: (url, init) => fetch(url, init),
  exec: async (cmd, args) => ({ stdout: (await execFileAsync(cmd, args, { encoding: 'utf8' })).stdout }),
  now: () => new Date(),
};

process.exitCode = await main(process.argv.slice(2), realDeps);
