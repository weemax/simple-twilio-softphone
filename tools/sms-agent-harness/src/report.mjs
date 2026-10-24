// Live results document. Written after every case so a run that is killed
// halfway still leaves a usable record.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ICON = { PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLOCKED', NEEDS_REVIEW: 'REVIEW' };

export class Report {
  constructor(dir, meta) {
    this.dir = dir;
    this.meta = meta;
    this.results = [];
    mkdirSync(dir, { recursive: true });
    this.flush();
  }

  add(result) {
    this.results.push(result);
    this.flush();
  }

  counts() {
    const c = { PASS: 0, FAIL: 0, BLOCKED: 0, NEEDS_REVIEW: 0 };
    for (const r of this.results) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
    return c;
  }

  /**
   * Pass rate counts only cases that actually ran. BLOCKED and NEEDS_REVIEW are
   * excluded from both halves so a suite that mostly did not run cannot report
   * a high percentage.
   */
  passRate(filter = () => true) {
    const ran = this.results.filter((r) => filter(r) && (r.verdict === 'PASS' || r.verdict === 'FAIL'));
    if (!ran.length) return null;
    return (ran.filter((r) => r.verdict === 'PASS').length / ran.length) * 100;
  }

  flush() {
    writeFileSync(join(this.dir, 'results.md'), this.markdown());
    writeFileSync(join(this.dir, 'results.json'), JSON.stringify({ meta: this.meta, results: this.results }, null, 2));
  }

  markdown() {
    const c = this.counts();
    const total = this.results.length;
    const blocking = this.passRate((r) => r.blocking);
    const overall = this.passRate();
    const fmt = (n) => (n === null ? 'n/a' : `${n.toFixed(1)}%`);

    const lines = [
      `# SMS Agent Test Run - ${this.meta.client}`,
      '',
      `- **Backend:** ${this.meta.backend} (${this.meta.backendLabel})`,
      `- **Started:** ${this.meta.started}`,
      `- **Cases selected:** ${this.meta.total}`,
      `- **Status:** ${total === this.meta.total ? 'complete' : `in progress, ${total}/${this.meta.total} done`}`,
      '',
      '## Summary',
      '',
      '| verdict | count |',
      '|---|---|',
      `| PASS | ${c.PASS} |`,
      `| FAIL | ${c.FAIL} |`,
      `| BLOCKED | ${c.BLOCKED} |`,
      `| NEEDS_REVIEW | ${c.NEEDS_REVIEW} |`,
      '',
      `Pass rate, blocking cases: **${fmt(blocking)}** (release criteria require 100%)`,
      `Pass rate, all cases that ran: **${fmt(overall)}** (release criteria require 95%)`,
      '',
      'BLOCKED and NEEDS_REVIEW are excluded from both rates. A case that could',
      'not be set up is not a passing case.',
      '',
    ];

    const failing = this.results.filter((r) => r.verdict === 'FAIL');
    if (failing.length) {
      lines.push('## Failures', '');
      for (const r of failing) lines.push(...this.detail(r));
    }

    const review = this.results.filter((r) => r.verdict === 'NEEDS_REVIEW');
    if (review.length) {
      lines.push('## Needs review', '',
        'The two judge passes disagreed. These are not counted either way.', '');
      for (const r of review) lines.push(...this.detail(r));
    }

    const blocked = this.results.filter((r) => r.verdict === 'BLOCKED');
    if (blocked.length) {
      lines.push('## Blocked', '', '| case | blocking | reason |', '|---|---|---|');
      for (const r of blocked) {
        lines.push(`| ${r.id} ${r.title} | ${r.blocking ? 'yes' : 'no'} | ${r.reason ?? ''} |`);
      }
      lines.push('');
    }

    lines.push('## All cases', '', '| case | suite | blocking | verdict |', '|---|---|---|---|');
    for (const r of this.results) {
      lines.push(`| ${r.id} ${r.title} | ${r.suite} | ${r.blocking ? 'yes' : ''} | ${ICON[r.verdict]} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  detail(r) {
    const out = [`### ${r.id} - ${r.title}`, '', `Suite: \`${r.suite}\`  Blocking: ${r.blocking ? 'yes' : 'no'}  Source: \`${r.source_ref ?? ''}\``, ''];
    if (r.failures?.length) {
      out.push('**Assertions that failed**', '');
      for (const f of r.failures) out.push(`- ${f}`);
      out.push('');
    }
    if (r.needsReview?.length) {
      out.push('**Judges disagreed**', '');
      for (const f of r.needsReview) out.push(`- ${f}`);
      out.push('');
    }
    out.push('**Transcript**', '', '```');
    for (const t of r.turns ?? []) {
      if (t.sent !== undefined) out.push(`CUSTOMER: ${t.sent}`);
      for (const m of t.received ?? []) out.push(`AGENT:    ${m}`);
      if ((t.received ?? []).length === 0) out.push(`AGENT:    (no reply within ${t.waited}s)`);
    }
    out.push('```', '');
    if (r.toolCalls?.length) {
      out.push('**Tool calls**', '', '```');
      for (const c of r.toolCalls) out.push(`${c.name}(${JSON.stringify(c.args ?? {})}) -> ${JSON.stringify(c.result ?? null)}`);
      out.push('```', '');
    }
    return out;
  }
}
