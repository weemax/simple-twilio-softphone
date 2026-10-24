// Loads compiled case files. The compiler (skill: sms-agent-testcases) owns the
// schema; this only loads, orders, and filters.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Default import for interop: the resolved `yaml` may be CJS (v1) or ESM (v2),
// and the named export only exists on v2.
import YAML from 'yaml';

const parse = YAML.parse ?? YAML.default?.parse;

export function loadCases(dir, { backend, only, suite } = {}) {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  let globalDoc = null;
  const cases = [];

  for (const f of files) {
    const doc = parse(readFileSync(join(dir, f), 'utf8'));
    if (f.startsWith('_global')) { globalDoc = doc; continue; }
    doc._file = f;
    cases.push(doc);
  }

  let selected = cases;
  if (backend) selected = selected.filter((c) => (c.backends ?? []).includes(backend));
  if (suite) selected = selected.filter((c) => (c.suite ?? '').startsWith(suite));
  if (only?.length) {
    const want = new Set(only.map(String));
    selected = selected.filter((c) => want.has(String(c.id)));
  }

  return { globalDoc, cases: order(selected) };
}

/**
 * Cases that poison the test number run last, so their recovery cannot corrupt
 * the cases that follow. Everything else keeps criteria-doc order.
 */
export function order(cases) {
  const clean = cases.filter((c) => !c.poisons_number);
  const poisoning = cases.filter((c) => c.poisons_number);
  const byId = (a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
  return [...clean.sort(byId), ...poisoning.sort(byId)];
}

export const DEFAULTS = { timeout: 120, settle: 20 };

export const caseTimeout = (c) => c.timeout ?? DEFAULTS.timeout;
export const caseSettle = (c) => c.settle ?? DEFAULTS.settle;
