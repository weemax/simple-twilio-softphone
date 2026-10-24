// TruHome Pros run configuration for backend B.
//
//   node bin/sms-agent-test.mjs --cases ../../tests/truhome/sms_agent/cases \
//     --backend B --client truhome --adapter ./adapters/truhome.mjs --db ./adapters/supabase-db.mjs
//
// Prerequisite, in the platform repo:
//   cd backend && AI_TEST_MODE=true PORT=3001 npm run dev
//
// WARNING: /test/ai/simulate sends real SMS. `from` below is the operator's own
// number (+15089785987, the TWILIO_CALLER_ID in this repo's server/.env), so the
// only phone that rings is the tester's. Do not point this at a client contact.

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createAdapter } from './deepseek.mjs';
import db from './supabase-db.mjs';

const DEEPSEEK = process.env.DEEPSEEK_ROOT
  ?? resolve(process.env.HOME, 'firstmate/projects/deepseek');

/**
 * Operator credentials. Env wins; otherwise fall back to the platform repo's
 * scripts/.env, which is where the operator password already lives. Explicit
 * rather than implicit: it logs which source it used, and never prints the value.
 */
function loadOperatorCredentials() {
  if (process.env.SUPABASE_JWT) return 'SUPABASE_JWT';
  if (process.env.SUPABASE_EMAIL && process.env.SUPABASE_PASSWORD) return 'environment';

  process.env.SUPABASE_EMAIL ??= 'izzy@channelautomation.com';
  const envPath = join(DEEPSEEK, 'scripts/.env');
  try {
    const pw = readFileSync(envPath, 'utf8').match(/^IZZY_PW=(.*)$/m)?.[1]?.trim();
    if (pw) {
      process.env.SUPABASE_PASSWORD = pw;
      return `${envPath} (IZZY_PW)`;
    }
  } catch { /* fall through to the error below */ }

  throw new Error(
    'no operator credentials: set SUPABASE_EMAIL and SUPABASE_PASSWORD, ' +
    `or put IZZY_PW in ${envPath}`,
  );
}

// Verified live against workspace 13604 on 2026-08-26.
export const target = {
  workspaceId: '13604',
  agentId: 'db8d66c0-6a8e-4bf0-ac60-a30605f65153',

  // Izzy Maxino / +15089785987. Do not use the contact originally supplied:
  // it is a real lead on a live campaign.
  contactId: 'a0a0ac14-3760-49cc-9a96-d620bec463c2',
  from: '+15089785987',

  // The workspace's Twilio number, so the reply actually sends and saves.
  // Defaults to main_847, the Chicago-area main line (the campaign tags on this
  // workspace are 847/224 Chicago). Override with TRUHOME_SMS_NUMBER.
  //
  // Caveat: all 33 of this workspace's numbers have in_rotation = true. If the
  // agent replies from a rotating number rather than the one it was texted,
  // backend A will read an empty thread and report every case as "no reply".
  // Verify empirically before the first backend A run: send one message from the
  // softphone and check which number answers.
  to: process.env.TRUHOME_SMS_NUMBER ?? '+18478860675',
};

console.error(`[truhome] operator credentials from: ${loadOperatorCredentials()}`);
export default createAdapter({ target, db });
