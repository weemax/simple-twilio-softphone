// Platform state reader, authenticated as the operator.
//
// Auth is the operator's email + password, exchanged for a Supabase user JWT,
// exactly as the frontend does. No service-role key: an operator session is
// scoped by RLS to the workspaces that operator can actually see, which is the
// right blast radius for a suite that runs against a live client workspace.
//
// It reuses the platform's own helper rather than reimplementing the login:
//   <deepseek>/scripts/lib/sequence-auth.js
// Reimplementing it here would be the same mistake as grading against
// testChatService.js. Shared code that drifts is worse than a hard dependency.

import { resolve, join } from 'node:path';

const DEEPSEEK = process.env.DEEPSEEK_ROOT
  ?? resolve(process.env.HOME, 'firstmate/projects/deepseek');

let cached = null;

async function session() {
  if (cached) return cached;

  const authPath = join(DEEPSEEK, 'scripts/lib/sequence-auth.js');
  let mod;
  try {
    mod = await import(authPath);
  } catch (err) {
    throw new Error(
      `cannot load the platform auth helper at ${authPath} ` +
      `(set DEEPSEEK_ROOT): ${err.message}`,
    );
  }

  const email = process.env.SUPABASE_EMAIL;
  const password = process.env.SUPABASE_PASSWORD;
  if (!process.env.SUPABASE_JWT && !(email && password)) {
    throw new Error('set SUPABASE_EMAIL and SUPABASE_PASSWORD (or SUPABASE_JWT)');
  }

  const { token } = await mod.resolveAuthToken({ email, password, jwt: process.env.SUPABASE_JWT });
  const { url, anonKey } = mod.resolveSupabaseRest();
  if (!url || !anonKey) throw new Error('could not resolve the Supabase URL / anon key');

  cached = { token, url, anonKey };
  return cached;
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const { token, url, anonKey } = await session();
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${url}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Resolve a workspace's custom-field names to ids.
 *
 * Case files reference qualification answers symbolically (`custom:roof_age`).
 * The platform stores them in `contact_custom_fields` keyed by `custom_fields.id`,
 * where `custom_fields.name` is the human key (`qq_project_interest`,
 * `qq_home_ownership`, ...). This is the same lookup the platform's own AI test
 * harness does in resolveFieldIds().
 */
const fieldCache = new Map();
async function fieldId(workspaceId, name) {
  const key = `${workspaceId}:${name}`;
  if (fieldCache.has(key)) return fieldCache.get(key);
  const rows = await rest(
    `custom_fields?workspace_id=eq.${workspaceId}&name=eq.${encodeURIComponent(name)}&select=id,name`,
  );
  const id = rows?.[0]?.id ?? null;
  fieldCache.set(key, id);
  return id;
}

/** List every custom field on a workspace. Used to build the key map. */
export async function listFields(workspaceId) {
  return rest(`custom_fields?workspace_id=eq.${workspaceId}&select=id,name,label&order=name`);
}

export default {
  async read(table, field, ctx) {
    const { contactId, workspaceId } = ctx;
    if (!contactId || !workspaceId) throw new Error('need contactId and workspaceId');

    if (table === 'contact_custom_fields') {
      const name = field.startsWith('custom:') ? field.slice(7) : field;
      const id = await fieldId(workspaceId, name);
      if (!id) throw new Error(`custom field "${name}" does not exist on this workspace`);
      const rows = await rest(
        `contact_custom_fields?contact_id=eq.${contactId}&field_id=eq.${id}&select=value`,
      );
      return rows?.[0]?.value ?? null;
    }

    const filter = table === 'contacts'
      ? `id=eq.${contactId}&workspace_id=eq.${workspaceId}`
      : `contact_id=eq.${contactId}&workspace_id=eq.${workspaceId}`;
    const rows = await rest(`${table}?${filter}&select=${encodeURIComponent(field)}`);
    return rows?.[0]?.[field] ?? null;
  },

  async write(table, fields, ctx) {
    const { contactId, workspaceId } = ctx;
    if (table === 'contacts') {
      await rest(`contacts?id=eq.${contactId}&workspace_id=eq.${workspaceId}`, {
        method: 'PATCH', body: fields, prefer: 'return=minimal',
      });
      return;
    }
    if (table === 'contact_custom_fields') {
      for (const [name, value] of Object.entries(fields)) {
        const id = await fieldId(workspaceId, name.replace(/^custom:/, ''));
        if (!id) throw new Error(`custom field "${name}" does not exist on this workspace`);
        await rest('contact_custom_fields', {
          method: 'POST',
          body: { contact_id: contactId, field_id: id, value },
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
      }
      return;
    }
    throw new Error(`no fixture writer for table "${table}"`);
  },

  /** Outbound agent messages created at or after `since`, oldest first. */
  async outboundSince(ctx, since) {
    const { contactId, workspaceId } = ctx;
    const rows = await rest(
      `livechat_messages?contact_id=eq.${contactId}&workspace_id=eq.${workspaceId}` +
      `&direction=eq.outbound&msg_type=eq.text&created_at=gte.${encodeURIComponent(since)}` +
      `&select=body,created_at&order=created_at.asc`,
    );
    return (rows ?? []).map((r) => r.body ?? '');
  },
};
