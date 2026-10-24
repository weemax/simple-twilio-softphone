// Deterministic assertions. Every check here is pure and binary: same input,
// same verdict, run after run. Anything that needs judgment lives in judge.mjs.
//
// Each checker returns null when it holds, or a string describing the failure.

import { isGsm7, nonGsm7Chars, septetLength, segmentCount } from './gsm7.mjs';

const PLACEHOLDER_PATTERNS = [
  /\{\{[^}]*\}\}/,          // {{contact.first_name}}
  /\[[A-Z][A-Z_ ]{2,}\]/,   // [ADDRESS]
  /\bundefined\b|\bnull\b/,
  /\bunknown\b/i,
];

// Stage labels from the criteria doc leak as often as merge fields do.
const STATE_LABEL = /\b(PROJECT|CONSULT|USE|QUALIFY|COVERAGE|SCHEDULE)\b/;

const URL_RE = /\bhttps?:\/\/\S+|\b[a-z0-9-]+\.(com|net|org|io|co|link|app)\/\S*/i;

const PRICE_RE = new RegExp(
  [
    '[$€£]\\s?\\d',                                   // $8,000
    '\\b\\d[\\d,]*\\s?(dollars|usd)\\b',
    '\\b\\d+\\s?%',                                    // 20% off
    // A price word plus a money-shaped number. A bare small count ("about 9
    // windows") is not a price, so require 3+ digits, comma grouping, or cents.
    '\\b(cost|costs|price|priced|runs|around|roughly|about|starting|from|between|up to)\\s+' +
      '\\$?(\\d{3,}|\\d[\\d,]*,\\d{3}|\\d+\\.\\d{2})\\b',                                       // "runs about 12000"
    '\\bper\\s+(square|window|door|foot|sq\\.?\\s?ft)\\b',
  ].join('|'),
  'i',
);

// Words that open a question without a question mark, and conjunctions that
// smuggle a second ask into one sentence.
const INTERROGATIVE = /\b(what|which|when|where|who|whom|whose|why|how|do you|does|did you|are you|is it|can you|could you|would you|will you|have you|has it|should)\b/i;
const IMPERATIVE_ASK = /\b(let me know|tell me|share|send me|confirm|give me)\b/i;

/**
 * Counts semantic questions, not "?" characters. Case 105 in the TruHome
 * criteria exists because agents evade a naive counter: "Let me know the roof
 * age and whether it leaks" is two asks with no question mark at all.
 */
export function countQuestions(text) {
  const clauses = text
    .split(/(?<=[?.!])\s+|\s*;\s+/)
    .map((c) => c.trim())
    .filter(Boolean);

  let count = 0;
  for (const clause of clauses) {
    const isAsk = clause.includes('?') || INTERROGATIVE.test(clause) || IMPERATIVE_ASK.test(clause);
    if (!isAsk) continue;
    count += 1;
    // "the roof age and whether it leaks" - "and whether/if/what" after an ask
    // is a second question riding along in the same clause.
    const smuggled = clause.match(
      /\b(and|or)\s+(whether|if|what|when|which|how|do|does|did|are|is|can|could|would|will|should|have|has)\b/gi,
    );
    if (smuggled) count += smuggled.length;
  }
  return count;
}

export function findPlaceholders(text) {
  const hits = [];
  for (const re of PLACEHOLDER_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  const label = text.match(STATE_LABEL);
  if (label) hits.push(label[0]);
  return hits;
}

export const hasLink = (text) => URL_RE.test(text);
export const hasPrice = (text) => PRICE_RE.test(text);

/** Rendered length. Extension chars cost two septets, so they count double. */
export function renderedLength(text) {
  const septets = septetLength(text);
  return septets === null ? [...text].length : septets;
}

// ---------------------------------------------------------------------------
// Per-message checks. `expect` keys map to functions of (message, value).
// ---------------------------------------------------------------------------

const PER_MESSAGE = {
  max_chars: (m, n) => {
    const len = renderedLength(m);
    return len <= n
      ? null
      : `rendered length ${len} exceeds ${n} (${segmentCount(m)} segments)`;
  },
  single_line: (m, on) => (!on || !/[\r\n]/.test(m) ? null : 'message contains a line break'),
  gsm7_only: (m, on) => {
    if (!on || isGsm7(m)) return null;
    return `non-GSM-7 characters: ${nonGsm7Chars(m).map((c) => JSON.stringify(c)).join(', ')}`;
  },
  max_questions: (m, n) => {
    const q = countQuestions(m);
    return q <= n ? null : `${q} questions, limit ${n}`;
  },
  no_placeholders: (m, on) => {
    if (!on) return null;
    const hits = findPlaceholders(m);
    return hits.length === 0 ? null : `placeholder leak: ${hits.join(', ')}`;
  },
  no_price: (m, on) => {
    if (!on) return null;
    return hasPrice(m) ? `price-shaped text: ${m.match(PRICE_RE)[0]}` : null;
  },
  contains: (m, s) => (m.toLowerCase().includes(String(s).toLowerCase()) ? null : `missing substring ${JSON.stringify(s)}`),
  not_contains: (m, s) => (m.toLowerCase().includes(String(s).toLowerCase()) ? `contains forbidden substring ${JSON.stringify(s)}` : null),
  regex: (m, p) => (new RegExp(p).test(m) ? null : `does not match /${p}/`),
  not_regex: (m, p) => {
    const hit = m.match(new RegExp(p));
    return hit ? `matches forbidden /${p}/ at ${JSON.stringify(hit[0])}` : null;
  },
};

// Assertions evaluated against the whole turn rather than each message.
const PER_TURN = new Set(['exact', 'max_messages', 'min_messages', 'silence', 'link', 'tool_called', 'tool_not_called', 'must', 'must_not']);

/**
 * Evaluate the deterministic half of one turn.
 *
 * @param {object} expect       the turn's expect block
 * @param {string[]} messages   agent messages received this turn, in order
 * @param {object} [ctx]        {toolCalls: [{name, args}]} from backend B
 * @returns {{failures: string[], semantic: {must: string[], must_not: string[]}}}
 */
export function checkTurn(expect = {}, messages = [], ctx = {}) {
  const failures = [];
  const joined = messages.join(' ');

  if (expect.silence !== undefined && messages.length > 0) {
    failures.push(`expected silence for ${expect.silence}s, got ${messages.length} message(s): ${JSON.stringify(messages[0])}`);
  }
  if (expect.max_messages !== undefined && messages.length > expect.max_messages) {
    failures.push(`${messages.length} messages, limit ${expect.max_messages}`);
  }
  if (expect.min_messages !== undefined && messages.length < expect.min_messages) {
    failures.push(`${messages.length} messages, minimum ${expect.min_messages}`);
  }
  if (expect.exact !== undefined) {
    if (messages.length !== 1) failures.push(`exact match needs exactly 1 message, got ${messages.length}`);
    else if (messages[0] !== expect.exact) {
      failures.push(`exact mismatch\n  expected: ${JSON.stringify(expect.exact)}\n  actual:   ${JSON.stringify(messages[0])}`);
    }
  }
  if (expect.link !== undefined) {
    const present = hasLink(joined);
    if (expect.link === 'present' && !present) failures.push('expected a link, none present');
    if (expect.link === 'absent' && present) failures.push(`unexpected link: ${joined.match(URL_RE)[0]}`);
  }

  const calls = ctx.toolCalls ?? [];
  if (expect.tool_called) {
    const want = typeof expect.tool_called === 'string' ? { name: expect.tool_called } : expect.tool_called;
    const call = calls.find((c) => c.name === want.name);
    if (!call) failures.push(`tool ${want.name} was not called (called: ${calls.map((c) => c.name).join(', ') || 'none'})`);
    else if (want.args) {
      for (const [k, v] of Object.entries(want.args)) {
        const got = call.args?.[k];
        if (String(got ?? '') !== String(v)) failures.push(`tool ${want.name} arg ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
      }
    }
  }
  if (expect.tool_not_called) {
    const name = expect.tool_not_called;
    if (calls.some((c) => c.name === name)) failures.push(`tool ${name} was called and should not have been`);
  }

  // Per-message checks run against every message in the turn, so a burst
  // cannot hide a violation in its second segment.
  for (const [key, value] of Object.entries(expect)) {
    if (PER_TURN.has(key) || value === undefined) continue;
    const fn = PER_MESSAGE[key];
    if (!fn) {
      failures.push(`unknown assertion "${key}" (harness bug or schema drift)`);
      continue;
    }
    messages.forEach((m, i) => {
      const err = fn(m, value);
      if (err) failures.push(messages.length > 1 ? `message ${i + 1}: ${err}` : err);
    });
  }

  return {
    failures,
    semantic: { must: expect.must ?? [], must_not: expect.must_not ?? [] },
  };
}

/** Global assertions, applied to every agent message in every case. */
export function checkGlobal(globalDoc, messages, caseId) {
  if (!globalDoc?.expect) return [];
  const exempt = new Set(
    (globalDoc.exempt ?? []).filter((e) => String(e.id) === String(caseId)).map((e) => e.field),
  );
  const expect = Object.fromEntries(
    Object.entries(globalDoc.expect).filter(([k]) => !exempt.has(k)),
  );
  return checkTurn(expect, messages).failures.map((f) => `[global] ${f}`);
}
