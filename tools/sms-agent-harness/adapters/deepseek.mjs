// Backend B adapter for the Channel Automation platform.
//
// It drives the platform's OWN dev test harness (backend/src/routes/aiTestHarness.js,
// mounted only when AI_TEST_MODE=true), which fires inbound messages through
// handleInboundTwilioMessage - the real orchestrator, not a reimplementation.
//
//   POST /test/ai/reset-contact  clean slate: contact, conversation state,
//                                dedupe row, tool logs, qualifying answers
//   POST /test/ai/set-config     agent function_calling_settings toggles
//   POST /test/ai/simulate       fire an inbound, return the decision
//
// TWO THINGS TO KNOW BEFORE RUNNING THIS
//
// 1. /test/ai/simulate SENDS REAL SMS. The route file says so: these endpoints
//    "perform DB writes AND send real SMS against the prod DB". Backend B is
//    faster than backend A and can control platform state, but it is not silent
//    and not free. Point `from` at the test number.
//
// 2. There is no forced-tool-result mode. The platform harness can enable and
//    disable functions, and it reports whether one fired and why it was blocked,
//    but it cannot make a function return a scripted payload, time out, or come
//    back malformed. Stub modes success/timeout/malformed therefore CANNOT run,
//    and this adapter refuses them rather than grading a case that did not test
//    what it claims. The platform's own scenario runner notes the same gap
//    ("may be flaky until a forced-tool test mode exists").

const SUPPORTED_MODES = new Set(['real', 'blocked']);

// Case-file function names to the platform's function_calling_settings toggles.
const TOGGLE = {
  appointment_booked: 'appointment_booked',
  check_service_area: 'check_service_area',
  escalate_to_human: 'escalate_to_human',
  request_callback: 'request_callback',
  mark_do_not_contact: 'mark_do_not_contact',
};

export function createAdapter({
  baseUrl = process.env.AI_TEST_BASE_URL ?? 'http://127.0.0.1:3001',
  user = process.env.AI_TEST_HARNESS_USER ?? 'admin',
  password = process.env.AI_TEST_HARNESS_PASSWORD,
  target,
  db,
} = {}) {
  const required = ['workspaceId', 'agentId', 'contactId', 'from', 'to'];
  const missing = required.filter((k) => !target?.[k]);
  if (missing.length) throw new Error(`adapter target is missing: ${missing.join(', ')}`);
  if (!db?.outboundSince) throw new Error('adapter needs a db client exposing outboundSince()');

  const headers = { 'Content-Type': 'application/json' };
  if (password) headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

  const post = async (path, body) => {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };

  const ctx = { contactId: target.contactId, workspaceId: target.workspaceId };
  let functionsOff = new Set();

  return {
    ctx,

    async health() {
      let res;
      try {
        res = await fetch(`${baseUrl}/test/ai/ui`, { headers });
      } catch (err) {
        throw new Error(
          `cannot reach the platform backend at ${baseUrl} (${err.message}). ` +
          'Start it with: cd backend && AI_TEST_MODE=true PORT=3001 npm run dev',
        );
      }
      if (res.status === 404) {
        throw new Error(
          'the platform AI test harness is not mounted. Start the backend with ' +
          'AI_TEST_MODE=true (cd backend && AI_TEST_MODE=true PORT=3001 npm run dev)',
        );
      }
      if (res.status === 401) throw new Error('AI test harness rejected auth; set AI_TEST_HARNESS_PASSWORD');
      if (!res.ok) throw new Error(`AI test harness unhealthy: ${res.status}`);
    },

    /**
     * Refuses the stub modes the platform cannot express. The runner turns this
     * into BLOCKED, which is the honest verdict: the case did not run.
     */
    configureStubs(spec = {}) {
      functionsOff = new Set();
      for (const [name, rule] of Object.entries(spec)) {
        const mode = rule?.mode ?? 'real';
        if (!SUPPORTED_MODES.has(mode)) {
          throw new Error(
            `stub mode "${mode}" for ${name} needs a forced-tool-result mode the platform ` +
            'AI test harness does not have. Supported here: real, blocked.',
          );
        }
        if (!TOGGLE[name]) throw new Error(`unknown AI function "${name}"`);
        if (mode === 'blocked') functionsOff.add(TOGGLE[name]);
      }
    },

    /** CLEARTEST equivalent: the platform's own one-call clean slate. */
    async reset({ qualifyingAnswered = [], qualifyingUnanswered = [] } = {}) {
      await post('/test/ai/reset-contact', {
        contactId: target.contactId,
        workspaceId: target.workspaceId,
        leadStatus: 'New Lead',
        bookingOffered: false,
        bookingConfirmed: false,
        exchangeCount: 0,
        clearDedupe: true,
        clearLogs: true,
        clearAppointments: true,
        resetAiContext: true,
        qualifyingAnswered,
        qualifyingUnanswered,
      });

      const settings = {};
      for (const toggle of Object.values(TOGGLE)) {
        if (!functionsOff.has(toggle)) settings[toggle] = true;
      }
      await post('/test/ai/set-config', { agentId: target.agentId, functionCallingSettings: settings });
    },

    /**
     * Fire one inbound and return every agent message it produced.
     *
     * /test/ai/simulate returns only the most recent outbound reply, so a burst
     * would collapse to its last message and a violation in the first would go
     * unseen. The messages are re-read from livechat_messages instead.
     */
    async deliverInbound(body, stubs) {
      const since = new Date(Date.now() - 1000).toISOString();

      const decision = await post('/test/ai/simulate', {
        workspaceId: target.workspaceId,
        contactId: target.contactId,
        from: target.from,
        to: target.to,
        body,
      });

      // Surface what the platform reports about function activity so
      // tool_called / tool_not_called assertions have something to read.
      if (decision.functionRun) {
        stubs.calls.push({
          name: 'appointment_booked',
          args: {},
          mode: functionsOff.has('appointment_booked') ? 'blocked' : 'real',
          result: {
            status: decision.functionRun.status,
            blocked_reason: decision.functionRun.blocked_reason,
            outcome: decision.outcome,
            reason: decision.reason,
          },
        });
      }

      const messages = await db.outboundSince(ctx, since);
      if (messages.length === 0 && decision.reply) return [decision.reply];
      return messages;
    },
  };
}

export default createAdapter;
