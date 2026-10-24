import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSuite } from '../src/run.mjs';
import { order } from '../src/cases.mjs';

/** A backend that replays scripted agent replies. No network, no Twilio. */
class FakeBackend {
  static label = 'fake';
  constructor(script, { stubs = true } = {}) {
    this.script = script;   // array of arrays: replies per send()
    this.i = 0;
    this.calls = [];
    this._stubs = stubs;
    this.sent = [];
  }
  async health() {}
  async markBaseline() {}
  configureStubs(spec) { this.spec = spec; }
  async send(body) { this.sent.push(body); this.pending = body === 'CLEARTEST' ? [] : (this.script[this.i++] ?? []); }
  async collect() { const r = this.pending ?? []; this.pending = []; return { received: r, waited: 0 }; }
  get toolCalls() { return this.calls; }
  supportsStubs() { return this._stubs; }
}

const memDb = (state = {}) => ({
  store: { ...state },
  async read(table, field) { return this.store[`${table}.${field}`]; },
  async write(table, fields) { for (const [k, v] of Object.entries(fields)) this.store[`${table}.${k}`] = v; },
});

const outDir = () => mkdtempSync(join(tmpdir(), 'smsharness-'));

const run = (cases, backend, db = memDb(), globalDoc = null) =>
  runSuite({ cases, globalDoc, backend, db, outDir: outDir(), dryRun: true, dbCtx: {}, meta: { client: 't', backend: 'B', started: 'now' } });

test('a clean case passes', async () => {
  const kase = {
    id: '002', title: 'Explicit STOP', suite: 'compliance/opt-out', blocking: true,
    backends: ['B'], trigger: 'inbound', fixture: { reset: 'cleartest' },
    turns: [{ send: 'STOP', expect: { exact: 'Understood.', max_messages: 1 } }],
  };
  const report = await run([kase], new FakeBackend([['Understood.']]));
  assert.equal(report.results[0].verdict, 'PASS');
  assert.equal(report.passRate(), 100);
});

test('a wrong reply fails and the transcript is recorded', async () => {
  const kase = {
    id: '002', title: 'Explicit STOP', suite: 'compliance/opt-out', blocking: true,
    backends: ['B'], turns: [{ send: 'STOP', expect: { exact: 'Understood.' } }],
  };
  const report = await run([kase], new FakeBackend([['Sure thing!']]));
  const r = report.results[0];
  assert.equal(r.verdict, 'FAIL');
  assert.match(r.failures.join(), /exact mismatch/);
  assert.deepEqual(r.turns[0].received, ['Sure thing!']);
});

test('a failed setup_verify is BLOCKED, not FAIL', async () => {
  const kase = {
    id: '001', title: 'DNC', suite: 'compliance/opt-out', blocking: true, backends: ['B'],
    setup_verify: [{ table: 'contacts', field: 'lead_status', op: 'eq', value: 'DNC' }],
    turns: [{ expect: { silence: 120 } }],
  };
  const report = await run([kase], new FakeBackend([[]]), memDb({ 'contacts.lead_status': 'New' }));
  const r = report.results[0];
  assert.equal(r.verdict, 'BLOCKED', 'fixture failure must not be blamed on the agent');
  assert.match(r.reason, /setup not established/);
});

test('BLOCKED and NEEDS_REVIEW are excluded from the pass rate', async () => {
  const pass = { id: '1', title: 'a', suite: 's', blocking: true, backends: ['B'], turns: [{ send: 'x', expect: { exact: 'ok' } }] };
  const blocked = { id: '2', title: 'b', suite: 's', blocking: true, backends: ['B'], blocked_reason: 'no fixture', turns: [] };
  const report = await run([pass, blocked], new FakeBackend([['ok']]));
  assert.equal(report.counts().PASS, 1);
  assert.equal(report.counts().BLOCKED, 1);
  assert.equal(report.passRate(), 100, '1 of 1 that ran, not 1 of 2');
});

test('a case needing stubs is BLOCKED on a backend that cannot stub', async () => {
  const kase = {
    id: '076', title: 'timeout', suite: 'coverage', blocking: true, backends: ['B'],
    fixture: { tools: { check_service_area: { mode: 'timeout' } } },
    turns: [{ send: 'addr', expect: {} }],
  };
  const report = await run([kase], new FakeBackend([['ok']], { stubs: false }));
  assert.equal(report.results[0].verdict, 'BLOCKED');
  assert.match(report.results[0].reason, /cannot intercept/);
});

test('db_expect catches a reply that saved nothing', async () => {
  const kase = {
    id: '028', title: 'save answers', suite: 'memory', blocking: false, backends: ['B'],
    turns: [{ send: 'Roof is 12 years old', expect: {} }],
    db_expect: [{ table: 'contact_custom_fields', field: 'custom:roof_age', op: 'exists' }],
  };
  const report = await run([kase], new FakeBackend([['Got it, thanks!']]));
  assert.equal(report.results[0].verdict, 'FAIL');
  assert.match(report.results[0].failures.join(), /db: contact_custom_fields\.custom:roof_age/);
});

test('unverified recovery halts the run instead of reporting garbage', async () => {
  const poisoning = {
    id: '002', title: 'stop', suite: 'compliance/opt-out', blocking: true, backends: ['B'],
    poisons_number: true,
    turns: [{ send: 'STOP', expect: { exact: 'Understood.' } }],
    teardown: [
      { send: 'START' }, { wait: 0 }, { send: 'CLEARTEST' },
      { verify: { table: 'contacts', field: 'opted_in_sms', op: 'eq', value: true } },
    ],
  };
  const later = { id: '050', title: 'later', suite: 's', blocking: false, backends: ['B'], turns: [{ send: 'x', expect: {} }] };
  // order() puts the poisoning case last, so reverse the input to prove it.
  const cases = order([poisoning, later]);
  assert.deepEqual(cases.map((c) => c.id), ['050', '002'], 'poisoning cases run last');

  const db = memDb({ 'contacts.opted_in_sms': false }); // recovery never lands
  const report = await runSuite({
    cases, globalDoc: null, backend: new FakeBackend([[], ['Understood.']]), db,
    outDir: outDir(), dryRun: true, dbCtx: {},
    meta: { client: 't', backend: 'B', started: 'now' },
  });
  assert.equal(report.results.length, 2);
  assert.equal(report.results[1].verdict, 'FAIL');
  assert.match(report.meta.halted, /recovery could not be verified/);
});

test('global assertions catch a violation during an unrelated case', async () => {
  const kase = {
    id: '047', title: 'ProVia', suite: 'product', blocking: false, backends: ['B'],
    turns: [{ send: 'Do you carry ProVia?', expect: {} }],
  };
  const globalDoc = { expect: { max_chars: 160, gsm7_only: true } };
  const report = await run([kase], new FakeBackend([['We carry the ProVia fiberglass line — great choice!']]), memDb(), globalDoc);
  assert.equal(report.results[0].verdict, 'FAIL');
  assert.match(report.results[0].failures.join(), /\[global\].*non-GSM-7.*—/);
});

test('the live document is written after every case', async () => {
  const dir = outDir();
  const cases = [
    { id: '1', title: 'first', suite: 's', blocking: true, backends: ['B'], turns: [{ send: 'x', expect: { exact: 'ok' } }] },
    { id: '2', title: 'second', suite: 's', blocking: true, backends: ['B'], turns: [{ send: 'y', expect: { exact: 'nope' } }] },
  ];
  await runSuite({
    cases, globalDoc: null, backend: new FakeBackend([['ok'], ['ok']]), db: memDb(),
    outDir: dir, dryRun: true, dbCtx: {}, meta: { client: 'truhome', backend: 'B', started: 'now' },
  });
  const md = readFileSync(join(dir, 'results.md'), 'utf8');
  assert.match(md, /# SMS Agent Test Run - truhome/);
  assert.match(md, /\| PASS \| 1 \|/);
  assert.match(md, /\| FAIL \| 1 \|/);
  assert.match(md, /## Failures/);
  assert.match(md, /CUSTOMER: y/);
  assert.match(md, /Pass rate, blocking cases: \*\*50\.0%\*\*/);
});

test('CLEARTEST is sent before each case', async () => {
  const backend = new FakeBackend([['ok']]);
  const kase = { id: '1', title: 'a', suite: 's', blocking: false, backends: ['B'], fixture: { reset: 'cleartest' }, turns: [{ send: 'hi', expect: {} }] };
  await runSuite({ cases: [kase], globalDoc: null, backend, db: memDb(), outDir: outDir(), dryRun: true, dbCtx: {}, resetOpts: { settleAfter: 0 }, meta: { client: 't', backend: 'B', started: 'now' } });
  assert.deepEqual(backend.sent, ['CLEARTEST', 'hi']);
});

// --- adapter integration -----------------------------------------------------

test('an unsupported stub mode is BLOCKED, not silently graded', async () => {
  const { PipelineBackend } = await import('../src/backends/pipeline.mjs');
  const adapter = {
    ctx: { contactId: 'c1', workspaceId: 'w1' },
    async health() {},
    configureStubs(spec) {
      for (const [n, r] of Object.entries(spec)) {
        if (!['real', 'blocked'].includes(r.mode)) {
          throw new Error(`stub mode "${r.mode}" for ${n} needs a forced-tool-result mode the platform does not have`);
        }
      }
    },
    async reset() {},
    async deliverInbound() { return ['whatever']; },
  };
  const backend = new PipelineBackend({ adapter });
  const kase = {
    id: '076', title: 'coverage timeout', suite: 'coverage', blocking: true, backends: ['B'],
    fixture: { tools: { check_service_area: { mode: 'timeout' } } },
    turns: [{ send: 'addr', expect: { link: 'absent' } }],
  };
  const report = await run([kase], backend);
  assert.equal(report.results[0].verdict, 'BLOCKED');
  assert.match(report.results[0].reason, /forced-tool-result mode/);
  assert.equal(report.passRate(), null, 'a suite where nothing ran has no pass rate');
});

test('a supported stub mode runs, and dbCtx comes from the adapter', async () => {
  const { PipelineBackend } = await import('../src/backends/pipeline.mjs');
  const seen = { reset: 0, sent: [] };
  const adapter = {
    ctx: { contactId: 'c1', workspaceId: 'w1' },
    async health() {},
    configureStubs() {},
    async reset() { seen.reset += 1; },
    async deliverInbound(body) { seen.sent.push(body); return ['I will have a specialist confirm.']; },
  };
  const backend = new PipelineBackend({ adapter });
  const db = {
    store: {},
    seenCtx: null,
    async read(t, f, ctx) { this.seenCtx = ctx; return this.store[`${t}.${f}`]; },
    async write() {},
  };
  db.store['contacts.lead_status'] = 'New Lead';
  const kase = {
    id: '045', title: 'metal roofing', suite: 'product', blocking: false, backends: ['B'],
    fixture: { tools: { appointment_booked: { mode: 'blocked' } } },
    turns: [{ send: 'Do you install metal roofing?', expect: { max_messages: 1 } }],
    db_expect: [{ table: 'contacts', field: 'lead_status', op: 'ne', value: 'Disqualified' }],
  };
  const report = await run([kase], backend, db);
  assert.equal(report.results[0].verdict, 'PASS');
  assert.equal(seen.reset, 1, 'the platform reset replaced the CLEARTEST text');
  assert.deepEqual(seen.sent, ['Do you install metal roofing?'], 'no CLEARTEST sent on backend B');
  assert.deepEqual(db.seenCtx, { contactId: 'c1', workspaceId: 'w1' }, 'db ctx comes from the adapter');
});
