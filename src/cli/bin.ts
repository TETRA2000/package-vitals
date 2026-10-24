#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { homedir } from 'node:os';
import { execFileText } from '../core/github/token.js';
import { main, type CliDeps } from './main.js';

const realDeps: CliDeps = {
  env: process.env,
  platform: process.platform,
  homeDir: homedir(),
  stdout: (s) => process.stdout.write(`${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
  fetch: (url, init) => fetch(url, init),
  exec: execFileText,
  now: () => new Date(),
};

process.exitCode = await main(process.argv.slice(2), realDeps);
