// Orchestrator. Runs cases in order, records each result as it lands.

import { checkTurn, checkGlobal } from './assertions.mjs';
import { checkDb, snapshot } from './db.mjs';
import { judge } from './judge.mjs';
import { caseTimeout, caseSettle } from './cases.mjs';
import { Report } from './report.mjs';

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

class Blocked extends Error {}

/**
 * Reset the agent's memory and the contact record between cases.
 *
 * CLEARTEST deletes the contact and recreates a default lead. It MUST be
 * allowlisted server-side to the test number: this suite runs against a live
 * client workspace, and an unscoped delete-by-keyword is one phone-number match
 * away from removing a real customer.
 */
async function reset(backend, { keyword = 'CLEARTEST', settleAfter = 10 } = {}) {
  // A backend with a native reset (the platform's /test/ai/reset-contact) uses
  // it: it is synchronous, verifiable, and does not depend on a keyword handler
  // that must be allowlisted before it is safe to fire.
  if (typeof backend.reset === 'function' && (await backend.reset())) return;

  await backend.send(keyword);
  await sleep(settleAfter);
  await backend.markBaseline();
}

async function teardown(backend, steps = []) {
  for (const step of steps) {
    if (step.send !== undefined) await backend.send(step.send);
    if (step.wait !== undefined) await sleep(step.wait);
    // step.verify is checked by the caller, which owns the db client.
  }
}

async function runCase(kase, deps) {
  const { backend, db, globalDoc, judgeOpts, dryRun } = deps;
  const dbCtx = backend.dbCtx ?? deps.dbCtx;
  const result = {
    id: kase.id, title: kase.title, suite: kase.suite,
    blocking: !!kase.blocking, source_ref: kase.source_ref,
    turns: [], failures: [], needsReview: [], toolCalls: [],
  };

  if (kase.blocked_reason) {
    return { ...result, verdict: 'BLOCKED', reason: kase.blocked_reason };
  }
  if (kase.fixture?.tools && !backend.supportsStubs()) {
    return { ...result, verdict: 'BLOCKED', reason: 'case needs stubbed AI functions; this backend cannot intercept them' };
  }

  try {
    // ---- fixture ---------------------------------------------------------
    if (backend.supportsStubs() && kase.fixture?.tools) {
      try {
        backend.configureStubs(kase.fixture.tools);
      } catch (err) {
        throw new Blocked(err.message);
      }
    }
    if (kase.fixture?.reset !== 'none') await reset(backend, deps.resetOpts);

    if (kase.fixture?.contact) {
      try {
        await db.write('contacts', kase.fixture.contact, dbCtx);
      } catch (err) {
        throw new Blocked(`could not write contact fixture: ${err.message}`);
      }
    }

    // setup_verify failures are BLOCKED, never FAIL: if the fixture did not
    // land, the agent is not the thing that broke.
    if (kase.setup_verify?.length) {
      const bad = await checkDb(db, kase.setup_verify, dbCtx);
      if (bad.length) throw new Blocked(`setup not established: ${bad.join('; ')}`);
    }

    const dbChecks = [...(kase.setup_verify ?? []), ...(kase.db_expect ?? [])];
    let before = new Map();
    if (dbChecks.length) {
      try { before = await snapshot(db, dbChecks, dbCtx); }
      catch (err) { throw new Blocked(`could not snapshot platform state: ${err.message}`); }
    }

    // ---- turns -----------------------------------------------------------
    const semantic = [];
    for (const turn of kase.turns ?? []) {
      if (turn.send !== undefined) await backend.send(turn.send);

      const wait = turn.expect?.silence !== undefined
        ? { timeout: turn.expect.silence, settle: 0 }
        : { timeout: caseTimeout(kase), settle: caseSettle(kase) };

      const { received, waited } = await backend.collect(wait);
      const record = { sent: turn.send, received, waited };
      result.turns.push(record);

      const ctx = { toolCalls: backend.toolCalls };
      const { failures, semantic: sem } = checkTurn(turn.expect ?? {}, received, ctx);
      result.failures.push(...failures.map((f) => `turn ${result.turns.length}: ${f}`));
      result.failures.push(...checkGlobal(globalDoc, received, kase.id));

      for (const text of sem.must) semantic.push({ kind: 'must', text });
      for (const text of sem.must_not) semantic.push({ kind: 'must_not', text });
    }

    result.toolCalls = backend.toolCalls;

    // ---- platform state --------------------------------------------------
    if (kase.db_expect?.length) {
      result.failures.push(...(await checkDb(db, kase.db_expect, dbCtx, before)).map((f) => `db: ${f}`));
    }

    // ---- semantic --------------------------------------------------------
    if (semantic.length && !dryRun) {
      const { failures, needsReview } = await judge(result.turns, semantic, judgeOpts);
      result.failures.push(...failures);
      result.needsReview.push(...needsReview);
    }

    // ---- recovery --------------------------------------------------------
    if (kase.poisons_number) {
      await teardown(backend, kase.teardown);
      const verifies = (kase.teardown ?? []).filter((s) => s.verify).map((s) => s.verify);
      if (verifies.length) {
        const bad = await checkDb(db, verifies, dbCtx);
        if (bad.length) {
          const msg = `recovery after case ${kase.id} could not be verified: ${bad.join('; ')}`;
          result.failures.push(msg);
          throw Object.assign(new Error(msg), { halt: true });
        }
      }
    }
  } catch (err) {
    if (err instanceof Blocked) return { ...result, verdict: 'BLOCKED', reason: err.message };
    if (err.halt) return { ...result, verdict: 'FAIL', halt: true };
    return { ...result, verdict: 'FAIL', failures: [...result.failures, `harness error: ${err.message}`] };
  }

  if (result.failures.length) return { ...result, verdict: 'FAIL' };
  if (result.needsReview.length) return { ...result, verdict: 'NEEDS_REVIEW' };
  return { ...result, verdict: 'PASS' };
}

export async function runSuite({ cases, globalDoc, backend, db, outDir, meta, ...deps }) {
  const report = new Report(outDir, { ...meta, total: cases.length, backendLabel: backend.constructor.label });
  await backend.health();

  for (const kase of cases) {
    const result = await runCase(kase, { backend, db, globalDoc, ...deps });
    report.add(result);

    // An unverified recovery means every later case runs against unknown
    // state. Reporting those results would be worse than reporting none.
    if (result.halt) {
      report.meta.halted = `stopped after case ${kase.id}: recovery could not be verified`;
      report.flush();
      break;
    }
  }
  return report;
}

export const _internal = { runCase, reset, teardown };
