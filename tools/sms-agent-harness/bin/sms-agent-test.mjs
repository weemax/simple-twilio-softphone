#!/usr/bin/env node
// Usage:
//   sms-agent-test --cases <dir> --backend A --target +15551234567 [options]
//   sms-agent-test --cases <dir> --backend B --adapter ./my-adapter.mjs
//
// Options:
//   --out <dir>       results directory (default: <cases>/../runs/<timestamp>)
//   --only 002,014    run just these case ids
//   --suite <prefix>  run cases whose suite starts with this
//   --dry-run         deterministic assertions only, no judge calls
//   --list            print the selected cases and exit

import { loadCases } from '../src/cases.mjs';
import { runSuite } from '../src/run.mjs';
import { SmsBackend } from '../src/backends/sms.mjs';
import { PipelineBackend, assertAdapter } from '../src/backends/pipeline.mjs';
import { unavailableDb } from '../src/db.mjs';
import { resolve, join, dirname } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const casesDir = resolve(flag('cases') ?? '');
const backendName = (flag('backend') ?? 'B').toUpperCase();
if (!casesDir || !['A', 'B'].includes(backendName)) {
  console.error('need --cases <dir> and --backend A|B');
  process.exit(2);
}

const { globalDoc, cases } = loadCases(casesDir, {
  backend: backendName,
  only: flag('only')?.split(','),
  suite: flag('suite'),
});

if (!cases.length) { console.error('no cases selected'); process.exit(2); }

if (has('list')) {
  for (const c of cases) {
    console.log(`${c.id}\t${c.blocking ? 'BLOCKING' : '        '}\t${c.suite}\t${c.title}`);
  }
  console.log(`\n${cases.length} cases selected for backend ${backendName}`);
  process.exit(0);
}

let backend;
if (backendName === 'A') {
  backend = new SmsBackend({ baseUrl: flag('server', 'http://127.0.0.1:5050'), target: flag('target') });
} else {
  const path = flag('adapter');
  if (!path) {
    console.error(
      'backend B needs --adapter <file.mjs> exporting { health, deliverInbound }.\n' +
      'See HARNESS.md, "Wiring backend B". Without it the platform pipeline cannot be reached.',
    );
    process.exit(2);
  }
  const mod = await import(resolve(path));
  backend = new PipelineBackend({ adapter: assertAdapter(mod.default ?? mod.adapter) });
}

let db = unavailableDb;
const dbPath = flag('db');
if (dbPath) {
  const mod = await import(resolve(dbPath));
  db = mod.default ?? mod.db;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(flag('out') ?? join(dirname(casesDir), 'runs', stamp));

const report = await runSuite({
  cases, globalDoc, backend, db, outDir,
  dryRun: has('dry-run'),
  dbCtx: { phone: flag('operator'), workspaceId: flag('workspace') },
  meta: { client: flag('client', 'unknown'), backend: backendName, started: new Date().toISOString() },
});

const c = report.counts();
console.log(`\n${outDir}/results.md`);
console.log(`PASS ${c.PASS}  FAIL ${c.FAIL}  BLOCKED ${c.BLOCKED}  NEEDS_REVIEW ${c.NEEDS_REVIEW}`);
process.exit(c.FAIL > 0 ? 1 : 0);
