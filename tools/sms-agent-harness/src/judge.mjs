// Semantic judge. Only reaches assertions that genuinely need judgment; the
// deterministic half never gets here.
//
// Determinism notes: temperature/top_p are removed on Opus 5 (the API rejects
// them), so run-to-run stability comes from three things instead: a fixed
// prompt, a strict tool schema that forces a shaped verdict, and a second
// independent pass on every FAIL. Disagreement is surfaced as NEEDS_REVIEW
// rather than resolved silently, because a judge that quietly breaks its own
// ties turns a flaky verdict into a confident one.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

const VERDICT_TOOL = {
  name: 'verdict',
  description: 'Record whether each requirement held, based only on the transcript.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['requirement', 'kind', 'held', 'evidence'],
          properties: {
            requirement: { type: 'string', description: 'The requirement text, copied verbatim.' },
            kind: { type: 'string', enum: ['must', 'must_not'] },
            held: { type: 'boolean', description: 'For must: the agent did it. For must_not: the agent did NOT do it.' },
            evidence: { type: 'string', description: 'The exact words from the agent message that decide it, or "none" if absent.' },
          },
        },
      },
    },
  },
};

const SYSTEM = `You judge SMS agent transcripts against explicit requirements.

You see the conversation and a list of requirements. You do not see the agent's
instructions, and you must not speculate about what the agent was trying to do.
Judge only what the messages actually say.

- A "must" requirement holds when the agent's messages plainly do the thing.
- A "must_not" requirement holds when the agent's messages plainly do NOT do the thing.
- Quote the deciding words in evidence. If nothing in the transcript decides it,
  the requirement does not hold and evidence is "none".
- Do not give credit for intent, implication, or near misses. Borderline is a
  failure, not a pass.`;

function renderTranscript(turns) {
  return turns
    .flatMap((t) => [
      t.sent === undefined ? null : `CUSTOMER: ${t.sent}`,
      ...(t.received ?? []).map((m) => `AGENT: ${m}`),
      (t.received ?? []).length === 0 ? 'AGENT: (no reply)' : null,
    ])
    .filter(Boolean)
    .join('\n');
}

async function judgeOnce(client, transcript, requirements) {
  const list = requirements
    .map((r, i) => `${i + 1}. [${r.kind}] ${r.text}`)
    .join('\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    tools: [VERDICT_TOOL],
    tool_choice: { type: 'tool', name: 'verdict' },
    output_config: { effort: 'medium' },
    messages: [{
      role: 'user',
      content: `TRANSCRIPT\n${transcript}\n\nREQUIREMENTS\n${list}\n\nRecord a verdict for each requirement, in order.`,
    }],
  });

  const call = response.content.find((b) => b.type === 'tool_use');
  if (!call) throw new Error(`judge returned no verdict (stop_reason: ${response.stop_reason})`);
  return call.input.results ?? [];
}

/**
 * @returns {Promise<{failures: string[], needsReview: string[]}>}
 */
export async function judge(turns, requirements, { client = new Anthropic() } = {}) {
  if (!requirements.length) return { failures: [], needsReview: [] };

  const transcript = renderTranscript(turns);
  const first = await judgeOnce(client, transcript, requirements);

  const failed = first.filter((r) => !r.held);
  if (!failed.length) return { failures: [], needsReview: [] };

  // Second independent pass over only the requirements the first pass failed.
  const disputed = requirements.filter((req) =>
    failed.some((f) => f.requirement === req.text || f.requirement.startsWith(req.text.slice(0, 40))),
  );
  const second = await judgeOnce(client, transcript, disputed.length ? disputed : requirements);

  const failures = [];
  const needsReview = [];
  for (const f of failed) {
    const echo = second.find((s) => s.requirement === f.requirement);
    const agreed = echo ? !echo.held : null;
    const line = `[${f.kind}] ${f.requirement} - evidence: ${f.evidence}`;
    if (agreed === true) failures.push(line);
    else needsReview.push(`${line} (second pass disagreed)`);
  }
  return { failures, needsReview };
}

export const _internal = { renderTranscript, VERDICT_TOOL, SYSTEM };
