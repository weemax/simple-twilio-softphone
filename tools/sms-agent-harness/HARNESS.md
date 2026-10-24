# SMS Agent Harness

Runs compiled acceptance cases against an SMS AI agent through two backends
that share one set of case files, one grader, and one results format.

| | Backend A | Backend B |
|---|---|---|
| Path | real SMS via the local softphone server | the platform's own reply pipeline |
| Agent sees | an ordinary inbound SMS from the operator's number | an ordinary inbound message |
| Can stub AI functions | no | yes |
| Wall clock, TruHome suite | ~3.2 h for 75 cases | minutes |
| Use it for | the release gate | every prompt edit |

Backend B is not a convenience. 37 of the 112 TruHome cases can only run with
the function layer stubbed: no amount of clever texting makes `check_service_area`
time out or a booking fail on demand. Most of the "zero fabricated appointments,
callbacks, transfers, coverage results" release criterion lives there.

When A and B disagree on a case, that disagreement is itself a finding. It means
something in the delivery path (segmentation, GSM-7 transcoding, truncation)
changed behavior, which is exactly what backend B alone cannot see.

## Install

```bash
cd tools/sms-agent-harness && npm install
npm test          # 27 tests, no network
```

## Run

```bash
# List what would run
node bin/sms-agent-test.mjs --cases ../../tests/truhome/sms_agent/cases \
  --backend A --list

# Backend A: real SMS. Needs the token server and an ngrok tunnel up.
node bin/sms-agent-test.mjs \
  --cases ../../tests/truhome/sms_agent/cases \
  --backend A --client truhome \
  --target +1XXXXXXXXXX \
  --db ./adapters/supabase-db.mjs

# Backend B: platform pipeline
node bin/sms-agent-test.mjs \
  --cases ../../tests/truhome/sms_agent/cases \
  --backend B --client truhome \
  --adapter ./adapters/deepseek.mjs \
  --db ./adapters/supabase-db.mjs
```

Options: `--only 002,014` (specific ids), `--suite compliance/opt-out`,
`--dry-run` (deterministic assertions only, no judge calls), `--out <dir>`.

Results land in `tests/<client>/sms_agent/runs/<timestamp>/` as `results.md`
(the live document) and `results.json` (for diffing runs). Both are rewritten
after every case, so a run killed halfway still leaves a usable record.

## How a case is graded

1. **Reset.** `CLEARTEST` clears agent context and recreates a default lead.
2. **Fixture.** Contact state is written; `setup_verify` confirms it landed.
   A failed `setup_verify` is **BLOCKED, never FAIL** - if the fixture did not
   write, the agent is not the thing that broke.
3. **Turns.** Each message is sent and the agent's reply collected. Two windows:
   `timeout` (default 120s) waits for the first message; `settle` (default 20s)
   waits for quiet after it. Agents send bursts, and judging the first message
   of a burst is the most common false-fail in SMS agent testing.
4. **Deterministic assertions** run against every message in the turn, so a
   violation cannot hide in a burst's second segment.
5. **Global assertions** (`_global.yaml`) run against every agent message in
   every case, attributed to whichever case they occurred in.
6. **Platform state.** `db_expect` reads the record. A reply that says exactly
   the right thing and saved nothing must fail, and only the database shows that.
7. **Semantic assertions** go to the judge, last and least.
8. **Recovery.** Cases marked `poisons_number` run last and must verify their
   teardown. Unverified recovery **halts the run** rather than reporting
   results for cases that ran against unknown state.

Verdicts: `PASS`, `FAIL`, `BLOCKED`, `NEEDS_REVIEW`. Only PASS and FAIL count
toward a pass rate. A suite that mostly did not run cannot report a high number.

## The judge

`temperature` and `top_p` are removed on Claude Opus 5 - the API rejects them -
so run-to-run stability does not come from sampling settings. It comes from:

- a **fixed prompt** and a **strict tool schema** that forces a shaped verdict,
- the judge seeing **only the transcript and the requirements**, never the
  agent's system prompt (give it the prompt and it starts reasoning about what
  the agent meant instead of what it did),
- a **second independent pass on every FAIL**. Agreement records a FAIL;
  disagreement records `NEEDS_REVIEW` and surfaces it for a human. A judge that
  quietly breaks its own ties turns a flaky verdict into a confident one.

Prefer deterministic assertions. Every one moved out of the judge removes a
source of noise from a suite graded on a pass percentage.

## Backend B: already wired

`adapters/deepseek.mjs` drives the platform's own dev test harness
(`backend/src/routes/aiTestHarness.js`), which fires inbound messages through
`handleInboundTwilioMessage` - the real orchestrator.

```bash
# Platform side: mount the harness
cd ~/firstmate/projects/deepseek/backend
AI_TEST_MODE=true PORT=3001 npm run dev

# Harness side
export SUPABASE_EMAIL=izzy@channelautomation.com
export SUPABASE_PASSWORD=...            # scripts/.env has IZZY_PW
export AI_TEST_BASE_URL=http://127.0.0.1:3001
export AI_TEST_HARNESS_PASSWORD=...     # required outside local dev
```

Auth is the operator's email and password exchanged for a Supabase user JWT via
the platform's own `scripts/lib/sequence-auth.js`. **No service-role key.** An
operator session is scoped by RLS to the workspaces that operator can see, which
is the right blast radius for a suite running against a live client workspace.

### Two limits to know before trusting a backend B run

**It sends real SMS.** `aiTestHarness.js` warns that `/test/ai/*` "performs DB
writes AND sends real SMS against the prod DB". Backend B is far faster than A
and can control platform state, but it is not silent and not free.

**There is no forced-tool-result mode.** The platform harness can enable and
disable functions and report whether one fired and why it was blocked. It cannot
make a function return a scripted payload, time out, or come back malformed. Of
the six stub modes the case schema defines, only `real` and `blocked` execute
today. The adapter **refuses** the others, so those cases report BLOCKED rather
than being graded on a condition that never occurred. 18 of the 112 TruHome
cases are affected, and most are the tool-truth cases the release criteria name
by name. The platform's own `scripts/run-ai-agent-scenarios.mjs` records the same
gap.

**`/test/ai/simulate` returns only the latest outbound reply**, so a burst would
collapse to its last message and a violation in the first would go unseen. The
adapter re-reads every outbound message from `livechat_messages` instead.

### Writing a different adapter

An adapter exports:

```js
export default {
  async health() { /* throw if the platform cannot be reached */ },

  // Run ONE inbound message through the real reply pipeline for the test
  // contact, routing every AI function call through
  // stubs.execute(name, args, realExecutor), and return the agent's outbound
  // message bodies in order.
  async deliverInbound(body, stubs) { /* -> string[] */ },
};
```

It must invoke the **real server-side path**. `POST /test/ai/simulate` does, via
`handleInboundTwilioMessage`.

**Do not build one on `frontend/src/components/my-ai-agent/services/testChatService.js`.**
That file calls `api.openai.com` directly from the browser and carries the
comment *"Mirrors backend's buildPrompt function exactly."* Mirrored code
drifts. Grading against it produces green runs for a prompt that behaves
differently in production.

Optional adapter methods: `reset(opts)` replaces the CLEARTEST text message with
a platform-native reset, `configureStubs(spec)` refuses stub modes the platform
cannot express, and `ctx` supplies `{contactId, workspaceId}` for db assertions.

### Stub modes

| mode | behavior |
|---|---|
| `real` | call the actual function (default) |
| `success` | return the scripted `returns` payload |
| `failure` | return an explicit failure |
| `timeout` | never resolve; the caller's own timeout must fire. If the platform has no timeout there, that is the finding |
| `malformed` | return a structurally invalid payload |
| `blocked` | record the call and its arguments, refuse the side effect |

`blocked` is what makes booking cases safe on a live workspace: the agent runs
all the way to `appointment_booked`, the call and its arguments are asserted,
and no real appointment is ever created.

## The database adapter

Exports `{ read(table, field, ctx), write(table, fields, ctx) }`.

Without `--db`, every database assertion throws and those cases become
**BLOCKED** rather than silently skipping - the difference between "we did not
check" and "it passed".

Known real columns (from the platform source, not guessed):

- `contacts.lead_status` - `'DNC'` is the do-not-contact gate (`backend/src/utils/dncUtils.js`, fails closed on a missing contact)
- `contacts.opted_in_sms` - the SMS opt-in gate (`backend/src/services/aiSafetyGate.js`)
- `ai_conversation_state` - `exchange_count`, `intent_history`, `objections_raised`, `objection_count`, `booking_offered`, `should_escalate`

Qualification answers live in `contact_custom_fields` keyed by `custom_fields.id`,
where `custom_fields.name` is the human key (`qq_project_interest`,
`qq_home_ownership`, ...). Cases reference them symbolically (`custom:roof_age`);
the adapter resolves the name to an id. List a workspace's fields with:

```bash
node -e "import('./adapters/supabase-db.mjs').then(m=>m.listFields('<workspaceId>').then(r=>console.table(r)))"
```

## Safety on a live workspace

- No case creates a real appointment. Booking paths run on backend B with
  `appointment_booked` stubbed.
- Backend B does not need `CLEARTEST`: it resets through
  `POST /test/ai/reset-contact`, which is synchronous and verifiable.
- Backend A still needs `CLEARTEST`, and **it must be allowlisted server-side to
  the single test number, as a constant.** This suite runs against a live client
  workspace; an unscoped delete-by-keyword is one phone-number match away from
  removing a real customer. Not implemented as of 2026-08-25.
- Backend B sends real SMS. Point `from` at the test number.
- Tag the test contact for exclusion from client reporting.

## Layout

```
src/
  assertions.mjs   deterministic checks (pure, binary, no network)
  gsm7.mjs         GSM 03.38 charset, septet length, segment count
  judge.mjs        semantic judge, strict tool schema, two-pass on FAIL
  db.mjs           platform state assertions
  cases.mjs        case loading and ordering
  report.mjs       live results document
  run.mjs          orchestrator
  backends/
    sms.mjs        backend A
    pipeline.mjs   backend B plus the stub layer and adapter contract
test/              27 tests, all offline
```

Case files are generated by the `sms-agent-testcases` skill from a criteria
doc. Edit the criteria doc and recompile; never hand-edit a case file.
