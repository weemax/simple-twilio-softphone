// Backend B: the platform's own reply pipeline, with the AI function layer
// stubbed so a test can force a coverage timeout, a booking failure, or a
// handoff that never lands.
//
// IMPORTANT: this must invoke the real server-side reply path, not the
// browser-side "test chat". frontend/src/components/my-ai-agent/services/
// testChatService.js calls api.openai.com directly and carries the comment
// "Mirrors backend's buildPrompt function exactly". Mirrored code drifts, so
// grading against it would produce green runs for a prompt that behaves
// differently in production.
//
// The real path is:
//   backend/src/services/inbound/twilioInboundDeferredProcessor.js
//     -> runInboundSmsDeferredProcessing()
//        -> backend/src/services/aiAgentService.js (processInboundForAI)
//           -> backend/src/services/aiFunctionsService.js (the tool layer)
//
// The adapter below is the seam. It is deliberately the only place that knows
// how to reach the platform, so wiring it is one file's worth of work.

export class StubbedFunctions {
  constructor(spec = {}) {
    this.spec = spec;
    this.calls = [];
  }

  /** Called by the adapter in place of the platform's function executor. */
  async execute(name, args, realExecutor) {
    const rule = this.spec[name];
    const mode = rule?.mode ?? 'real';
    const record = { name, args, mode };

    let result;
    switch (mode) {
      case 'real':
        result = await realExecutor(name, args);
        break;
      case 'success':
        result = rule.returns ?? { success: true };
        break;
      case 'failure':
        result = rule.returns ?? { success: false, error: 'stubbed failure' };
        break;
      case 'malformed':
        result = rule.returns ?? '<<not json>>';
        break;
      case 'timeout':
        // Never resolves on its own; the caller's own timeout must fire. If the
        // platform has no timeout here, that is itself the finding.
        result = await new Promise((_, reject) =>
          setTimeout(() => reject(new Error('stubbed tool timeout')), (rule.after ?? 30) * 1000),
        ).catch((e) => ({ error: e.message }));
        break;
      case 'blocked':
        // The call is recorded and its arguments are assertable, but nothing
        // downstream fires. This is what lets a booking-path case run to
        // completion on a live workspace without creating a real appointment.
        result = { blocked: true, error: 'blocked by test harness' };
        break;
      default:
        throw new Error(`unknown stub mode "${mode}" for ${name}`);
    }

    record.result = result;
    this.calls.push(record);
    return result;
  }
}

export class PipelineBackend {
  static label = 'platform pipeline dry-run';

  /**
   * @param {object} opts
   * @param {object} opts.adapter  platform adapter, see PlatformAdapter below
   */
  constructor({ adapter }) {
    if (!adapter) throw new Error('PipelineBackend needs a platform adapter');
    this.adapter = adapter;
    this.stubs = new StubbedFunctions();
  }

  async health() { return this.adapter.health(); }

  configureStubs(spec) {
    // The adapter gets first refusal: it knows which stub modes the platform
    // can actually express, and refusing here becomes BLOCKED rather than a
    // case that appears to test a timeout it never produced.
    this.adapter.configureStubs?.(spec);
    this.stubs = new StubbedFunctions(spec);
  }

  /** Platform-native reset, when the adapter offers one. */
  async reset(opts) {
    if (typeof this.adapter.reset !== 'function') return false;
    await this.adapter.reset(opts);
    this.pending = [];
    return true;
  }

  /** Platform state the adapter is bound to, for db assertions. */
  get dbCtx() { return this.adapter.ctx ?? null; }

  async markBaseline() { this.pending = []; }

  async send(body) {
    this.pending = await this.adapter.deliverInbound(body, this.stubs);
  }

  async collect() {
    const received = this.pending ?? [];
    this.pending = [];
    return { received, waited: 0 };
  }

  get toolCalls() { return this.stubs.calls; }
  supportsStubs() { return true; }
}

/**
 * The contract a platform adapter must satisfy.
 *
 * health()  -> throws if the platform cannot be reached
 * deliverInbound(body, stubs) -> Promise<string[]>
 *     Runs one inbound message through the real reply pipeline for the test
 *     contact, routing every AI function call through stubs.execute(name, args,
 *     realExecutor), and returns the agent's outbound message bodies in order.
 *
 * Not implemented here: wiring it requires the platform's runtime config
 * (Supabase service-role key, workspace id, agent config id) which is not
 * present in this repo. See HARNESS.md, "Wiring backend B".
 */
export const adapterContract = ['health', 'deliverInbound'];

export function assertAdapter(adapter) {
  const missing = adapterContract.filter((m) => typeof adapter?.[m] !== 'function');
  if (missing.length) throw new Error(`platform adapter is missing: ${missing.join(', ')}`);
  return adapter;
}
