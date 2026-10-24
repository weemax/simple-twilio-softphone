# TruHome Pros SMS Agent - Test Case Coverage

Compiled from `criteria.md` on 2026-08-25.
Validator: 112 cases, 0 errors, 0 warnings.

```
node ~/.claude/skills/sms-agent-testcases/scripts/validate-cases.mjs tests/truhome/sms_agent/cases
```

## Reconciliation against the criteria doc

| | count |
|---|---|
| Numbered items in `criteria.md` | 110 |
| Item 100 promoted to `_global.yaml` (not a numbered case) | -1 |
| Item 3 expanded into `003a`-`003d`, one per listed phrasing | +3 |
| **Case files emitted** | **112** |

Every numbered item produced a case. Nothing was dropped.

## By suite

| suite | cases |
|---|---|
| scheduling | 14 |
| eligibility/disqualification | 13 |
| compliance/opt-out | 11 |
| qualification/happy-path | 9 |
| memory/state-order | 9 |
| pricing/finance | 8 |
| product/boundaries | 8 |
| tool-truth/human-cancellation | 8 |
| coverage/address | 6 |
| required-field-refusal | 6 |
| compliance/terminal-priority | 5 |
| opening | 5 |
| output-contract | 5 |
| adversarial | 5 |

## By backend

| | cases | note |
|---|---|---|
| Runs on both A and B | 75 | |
| Backend B only | 37 | needs a stubbed function result, an outbound trigger, or must not touch a live calendar |
| Backend A only | 0 | |

Blocking cases: 75. Non-blocking: 37.

**Backend B is not optional.** 37 of 112 cases, including most of the tool-truth
suite the release criteria call out by name ("zero fabricated appointments,
callbacks, transfers, coverage results"), can only run with the AI function layer
stubbed. Real SMS cannot make `check_service_area` time out or make a booking
fail on demand.

## Update, 2026-08-25: platform tooling found

Reading the platform repo changed three things in this document. The earlier
"missing capability" list was written before finding `backend/src/routes/aiTestHarness.js`.

**1. Backend B already exists.** The platform ships a dev-only AI test harness,
mounted when `AI_TEST_MODE=true`, that fires inbound messages through
`handleInboundTwilioMessage` - the real orchestrator:

| endpoint | does |
|---|---|
| `POST /test/ai/reset-contact` | one-call clean slate: contact, conversation state, dedupe row, tool logs, qualifying answers |
| `POST /test/ai/set-config` | agent `function_calling_settings` toggles |
| `POST /test/ai/simulate` | fire an inbound, return reply plus outcome, `functionRun`, and state |

The harness adapter (`tools/sms-agent-harness/adapters/deepseek.mjs`) drives
these rather than reimplementing the pipeline. `reset-contact` also replaces
`CLEARTEST` on backend B: it is synchronous, verifiable, and does not depend on
a keyword handler that must be allowlisted first.

**2. The custom-field key map is resolved.** Queried live against workspace
13604 on 2026-08-26 (104 fields). The `qq_*` keys in the platform's scenario
fixture belong to a different workspace (Mad City); TruHome uses its own names:

| case-file key | TruHome field |
|---|---|
| `custom:ownership` | `homeownership` |
| `custom:property_use` | `is_primary_home` |
| `custom:address` | `property_address` |
| `custom:owner_names` | `coowner` |
| `custom:project_type` | `project_details` |

**Every per-project field is missing.** No roof age, roof leaks, storm damage,
window quantity, patio slider, siding condition, siding area, door quantity,
door type, replacement-vs-repair, patio type. No financing field either. There
is one generic `project_details`.

Per the author's decision (2026-08-26), those `db_expect` rows were downgraded
to assertions against `project_details`, and each affected case carries a
`needs_review` entry recording that field-level capture is unverifiable on this
schema. 21 case files were remapped; cases 19-23, 28, 29, 34, 36 lost
granularity this way.

This is a finding independent of the tests: if the agent is meant to capture
roof age and window counts and nothing stores them, that qualification data is
not reaching the CRM.

**2b. Mechanism (superseded detail).** Qualification answers
live in `contact_custom_fields` keyed by `custom_fields.id`, where
`custom_fields.name` is the human key. The platform's own scenarios use keys like
`qq_project_interest`, `qq_home_ownership`, `qq_confirmed_address`,
`qq_sole_decision_maker`, `qq_insurance_claim`. No service-role key is needed:
`scripts/lib/sequence-auth.js` exchanges the operator's `SUPABASE_EMAIL` /
`SUPABASE_PASSWORD` for a user JWT, and RLS then scopes reads to that operator's
workspaces - a better blast radius for a live-workspace suite than a service key.

The remaining work is mapping this doc's symbolic keys (`custom:roof_age`,
`custom:property_use`, ...) onto TruHome's actual `qq_*` names. One query:

```bash
node -e "import('./adapters/supabase-db.mjs').then(m=>m.listFields('<workspaceId>').then(r=>console.table(r)))"
```

**3. A new, larger gap: there is no forced-tool-result mode.** The platform
harness can enable and disable functions and report whether one fired and why it
was blocked. It cannot make a function return a scripted payload, time out, or
come back malformed. So of the six stub modes the case schema defines, only
`real` and `blocked` are executable today.

| stub mode | executable | cases |
|---|---|---|
| `real`, `blocked` | yes | 010, 025, 072, 087, 088, 089, 090, 107 |
| `success` | no | 025, 026, 027, 031, 074, 075, 078, 096, 097, 098 |
| `timeout` | no | 076, 077, 080, 094 |
| `failure` | no | 079, 084, 095, 099 |

**18 cases cannot run until the platform grows a forced-tool-result mode:**
025, 026, 027, 031, 074, 075, 076, 077, 078, 079, 080, 084, 094, 095, 096, 097,
098, 099. The adapter refuses these rather than grading them, so they report
BLOCKED. Most of them are the tool-truth cases the release criteria name
explicitly ("zero fabricated appointments, callbacks, transfers, coverage
results"), which means **that criterion is currently untestable**.

This is not a surprise to the platform team: `scripts/run-ai-agent-scenarios.mjs`
already carries the note that some scenarios "may be flaky until a forced-tool
test mode exists (see docs/testing/ optimization #6)".

**4. Backend B is not silent.** `aiTestHarness.js` warns that `/test/ai/*`
"performs DB writes AND sends real SMS against the prod DB". Backend B is much
faster than A and can control platform state, but it still sends messages. Point
`from` at the test number and expect the phone to buzz.

---

## BLOCKED: 10 cases that cannot run yet

The list below predates the finding above. Combined with the 18 forced-tool-mode
cases, **24 distinct cases are currently BLOCKED** (four overlap: 026, 031, 081
family and 101 are counted once each).


These are counted separately and never toward a pass rate. Four of them are
release-blocking, so the release criteria cannot currently be satisfied.

| case | blocking | missing capability |
|---|---|---|
| 010 human request after qualification | yes | writer for a completed-qualification state |
| 011 cancellation plus new project | yes | existing-appointment fixture |
| 026 no booking link configured | no | per-run agent config override |
| 030 CRM conflict | no | custom-field-key map |
| 031 address correction | no | custom-field-key map |
| 081 cancel with verified phone | **yes** | verified-number fixture + appointment fixture |
| 082 cancel without verified phone | **yes** | workspace fixture with no verified phone |
| 083 change request | **yes** | existing-appointment fixture |
| 093 weekend earliest-date rule | no | clock control |
| 101 long booking URL | **yes** | ready-to-book state + the real configured booking URL |

### Missing capabilities, consolidated

1. **`custom-field-key-map`** - RESOLVED in mechanism, pending the mapping.
   Operator email/password gives a user JWT via `scripts/lib/sequence-auth.js`;
   `listFields(workspaceId)` in the db adapter enumerates the workspace's
   `custom_fields`. What remains is mapping this doc's symbolic keys onto
   TruHome's actual `qq_*` names, then recompiling the affected cases.

1b. **`forced-tool-result`** - NEW, and the biggest gap. 18 cases need a function
   to return a scripted payload, time out, or fail. The platform AI test harness
   cannot do this. Until it can, the release criterion about fabricated
   appointments, callbacks, transfers, and coverage results has no test behind it.

2. **`outbound-trigger`** - cases 001, 014, 015, 016 need the agent to speak
   first. That is a campaign or sequence trigger, not a message, so they are
   backend B only until an API to fire an outbound at the test number exists.

3. **`appointment-fixture`** - cases 011, 081, 083 need an existing appointment
   on the test contact.

4. **`agent-config-override`** - case 026 needs the booking link unset for one
   run without editing the live client's agent config.

5. **`clock-control`** - case 093 asserts a weekend rule and is untestable unless
   the run can be frozen to a Saturday or Sunday. The case file carries a
   proposed `fixture.clock` field that is **not** part of the schema yet.

## NEEDS_REVIEW: 14 cases with unresolved prose

Each is recorded in the case file with the criteria text quoted verbatim and one
question. No assertion was guessed. Grouped by what would resolve them:

**The criteria doc names a thing it never defines**

- **025** - "all eight stages" are never listed. Which eight, in order? Until
  named, the case only asserts link-absent before the final turn, which is
  weaker than gating each stage.
- **007** - "unless the platform reports approval." What field sets and reads
  this? Only the negative branch is testable now.
- **040** - "unless expressly approved elsewhere." Same question for financing
  claims; if a flag can enable them, the approved branch needs its own case.
- **047** - the exact ProVia fiberglass line name. Without it the assertion
  cannot be a `contains` and falls back to a judge call.
- **081** - where the "verified number" is stored, so the assertion can be
  `contains <that value>` rather than a judgment.
- **060** - which field holds co-owner names.

**The case does not state its starting conversation state**

- **006** (which field is "current" when the emoji arrives), **015** (which CRM
  fields count as "populated"), **019** (is the roof question order fixed?),
  **032** (which field the ambiguous "Probably" answers), **010** (how
  "completed qualification" is established).

**The case compiles only one branch of a two-branch rule**

- **064** - solar is unambiguous, so only the "state limit and stop" branch is
  written. What input exercises the "clarify once" branch?
- **044** - "state only that the consultation is free" reads as a ceiling. Is the
  agent required to volunteer it, or merely permitted? Compiled as a `must_not`
  with no matching `must`.
- **091** - "only validated 10 AM, 2 PM, or 6 PM slots." Must the slots also come
  back from a host validation call, or is the fixed set sufficient? "Validated"
  implies a tool result this case does not stub.

## Compilation decisions worth reviewing

**Case 100 became `_global.yaml`.** One line, one question, 160 chars, GSM-7, and
no placeholder leaks now run against *every* agent message in *every* case,
attributed to whichever case they occurred in. Cases 101 and 102 are exempted
from the global `max_chars` because they exist to probe that boundary and assert
it themselves.

**Case 002 (exact STOP) may be testing Twilio, not the agent.** On backend A the
literal keyword is intercepted at the carrier or Messaging Service layer, so the
`exact` assertion could be matching Twilio's canned reply. The natural-language
cases 003a-003d are the ones that genuinely reach the platform. Confirm which
layer owns the acknowledgment before trusting an A-side result on 002.

**START is both a test subject and the recovery mechanism.** Case 007 asserts
START must not resume conversation, while every poisoning case's teardown sends
START to unblock the number at Twilio. Recovery therefore depends on CLEARTEST
recreating the contact, not on START restoring state. Four cases are marked
`poisons_number: true` (002, 007, 008, and the STOP path) and the runner must
verify recovery before continuing, or halt.

**Memory claims are DB assertions, not text assertions.** Cases 28, 29, 34, 35,
36, 4, and 9 assert against `contact_custom_fields` because an agent can say
exactly the right thing and save nothing. This is the largest fidelity gain from
having platform access, and it is currently gated on capability 1 above.

**"Do not disqualify" is a DB assertion too.** Cases 45, 52, 59, 61 check
`contacts.lead_status != 'Disqualified'`. Silent disqualification is invisible in
the reply text, which is exactly the failure mode those cases describe.

## Known platform context

- DNC is `contacts.lead_status === 'DNC'` (`backend/src/utils/dncUtils.js`),
  which fails closed on a missing contact.
- SMS opt-in is `contacts.opted_in_sms` (`backend/src/services/aiSafetyGate.js`).
- The safety gate carries a comment referencing a real 2026-05-26 incident where
  the AI Appointment Setter sent 15 SMS after an opt-out, caused by a missing
  regex in `optOutUtils` plus an either-channel bypass. Cases 003a-003d are the
  direct regression test for that incident.
- `aiSafetyGate.js` and `aiStopWordService.js` already implement part of the
  final release criterion (programmatic enforcement at the outbound boundary).
  Audit them against the criteria list before assuming the prompt must carry all
  of it.
- Conversation state lives in `ai_conversation_state` with columns including
  `exchange_count`, `intent_history`, `objections_raised`, `objection_count`,
  `booking_offered`, `should_escalate`.

## Safety notes for a live-workspace run

- No case creates a real appointment. Every booking path runs on backend B with
  `appointment_booked` stubbed `blocked` (assert the call, refuse the side
  effect) or `success` (scripted payload).
- `CLEARTEST` deletes a contact record. It must be allowlisted server-side to the
  single test number before any run. Not implemented as of 2026-08-25.
- The test contact should be tagged for exclusion from client reporting.


---

## Run configuration, verified 2026-08-26

| | value |
|---|---|
| workspace | `13604` |
| agent | `db8d66c0-6a8e-4bf0-ac60-a30605f65153` |
| test contact | `a0a0ac14-3760-49cc-9a96-d620bec463c2` (Izzy Maxino, +15089785987) |
| agent number (`to`) | `+18478860675` (main_847), override with `TRUHOME_SMS_NUMBER` |

**The contactId originally supplied is not a test contact.** It is a real lead
on a live campaign (identifiers omitted from this repository). Backend B sends real SMS, so running against it would have texted a
real customer once per turn and reset their record once per case. The correct
contact is the one on the operator's own number, which is also the record
backend A exercises, so both backends read the same state.

### Open risk for backend A: number rotation

All 33 of this workspace's Twilio numbers have `in_rotation = true`. If the
agent replies from a rotating number rather than the one it was texted, backend
A reads an empty thread and reports every case as "no reply". Verify
empirically before the first backend A run: send one message from the softphone
and check which number answers. Backend B is unaffected, since it reads
`livechat_messages` by contact rather than by thread.
