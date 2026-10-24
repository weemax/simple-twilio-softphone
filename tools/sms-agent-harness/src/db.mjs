// Platform state assertions. A correct-sounding reply that saved nothing must
// fail, and the only way to see that is to read the record.
//
// setup_verify failures are BLOCKED, not FAIL: if the fixture never wrote, the
// agent is not the thing that broke.

const OPS = {
  eq: (a, b) => String(a ?? '') === String(b),
  ne: (a, b) => String(a ?? '') !== String(b),
  exists: (a) => a !== null && a !== undefined && a !== '',
  absent: (a) => a === null || a === undefined || a === '',
  contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase()),
  gt: (a, b) => Number(a) > Number(b),
  lt: (a, b) => Number(a) < Number(b),
};

/**
 * A DbClient reads platform state. Implementations must provide:
 *   read(table, field, ctx) -> Promise<value>
 *   write(table, fields, ctx) -> Promise<void>
 * `ctx` carries {contactId, workspaceId, phone}.
 */

export async function snapshot(db, checks, ctx) {
  const snap = new Map();
  for (const c of checks) {
    const key = `${c.table}.${c.field}`;
    if (!snap.has(key)) snap.set(key, await db.read(c.table, c.field, ctx));
  }
  return snap;
}

/**
 * @param {Map} before  snapshot taken at setup time, for changed/unchanged
 * @returns {Promise<string[]>} failure descriptions
 */
export async function checkDb(db, checks = [], ctx, before = new Map()) {
  const failures = [];
  for (const c of checks) {
    const key = `${c.table}.${c.field}`;
    let actual;
    try {
      actual = await db.read(c.table, c.field, ctx);
    } catch (err) {
      failures.push(`${key}: read failed (${err.message})`);
      continue;
    }

    if (c.op === 'changed' || c.op === 'unchanged') {
      if (!before.has(key)) {
        failures.push(`${key}: ${c.op} needs a setup snapshot and none was taken`);
        continue;
      }
      const prior = before.get(key);
      const same = String(prior ?? '') === String(actual ?? '');
      if (c.op === 'changed' && same) failures.push(`${key}: expected a change, still ${JSON.stringify(actual)}`);
      if (c.op === 'unchanged' && !same) failures.push(`${key}: expected no change, ${JSON.stringify(prior)} -> ${JSON.stringify(actual)}`);
      continue;
    }

    const op = OPS[c.op ?? 'eq'];
    if (!op) { failures.push(`${key}: unknown op ${c.op}`); continue; }
    if (!op(actual, c.value)) {
      failures.push(`${key}: expected ${c.op ?? 'eq'} ${JSON.stringify(c.value ?? '')}, got ${JSON.stringify(actual)}`);
    }
  }
  return failures;
}

/**
 * A DbClient that refuses every read, used when no credentials are configured.
 * It makes cases BLOCKED rather than silently skipping their db assertions,
 * which is the difference between "we did not check" and "it passed".
 */
export const unavailableDb = {
  reason: 'no database credentials configured (need a Supabase service-role key)',
  async read() { throw new Error(this.reason); },
  async write() { throw new Error(this.reason); },
};
