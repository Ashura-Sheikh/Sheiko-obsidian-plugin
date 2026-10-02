// Builds the tests with esbuild (aliasing `obsidian` to test/obsidian-mock.ts),
// then runs them with Node's built-in test runner in the Europe/Dublin timezone.

import esbuild from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const out = path.join(root, 'test-dist');
const tests = readdirSync(path.join(root, 'test'))
	.filter((f) => f.endsWith('.test.ts'))
	.map((f) => path.join(root, 'test', f));

rmSync(out, { recursive: true, force: true });
await esbuild.build({
	entryPoints: tests,
	bundle: true,
	platform: 'node',
	format: 'esm',
	outdir: out,
	outExtension: { '.js': '.mjs' },
	alias: { obsidian: path.join(root, 'test', 'obsidian-mock.ts') },
	logLevel: 'warning',
});

const files = readdirSync(out).filter((f) => f.endsWith('.mjs')).map((f) => path.join(out, f));
const r = spawnSync(process.execPath, ['--test', ...files], {
	stdio: 'inherit',
	env: { ...process.env, TZ: 'Europe/Dublin' },
});
process.exit(r.status ?? 1);
