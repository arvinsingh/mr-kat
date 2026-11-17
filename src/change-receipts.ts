import { randomUUID } from 'node:crypto';
import type { App, Interaction, AuditOptions } from './types.js';
import { outcome } from './ui.js';
import { safe, safeMentions } from './util.js';
import { responsePolicies } from './response-policy.js';
import { logProfile } from './log-profile.js';

const detailed = new WeakSet<Interaction>();
export async function auditChange(
  app: App,
  i: Interaction,
  title: string,
  description: string,
  options: AuditOptions = {},
) {
  const url = await app.audit(i.guildId!, 'admin', title, description, {
    ...options,
    force: true,
    profile: options.profile ?? logProfile(app, i.user.id, i.member, i.user),
  });
  // Keep the stored receipt even when its redundant admin-channel copy is omitted.
  // A disabled/missing/failed destination must not suppress the fallback receipt.
  if (url) detailed.add(i);
  return url;
}

export interface ChangeReceipt {
  path: string;
  actor: string;
  at: number;
  result: string;
}
export async function recordChange(app: App, i: Interaction, path: string) {
  if (responsePolicies[path] !== 'staff') return;
  const result = outcome(i);
  if (result === undefined) return;
  const receipt: ChangeReceipt = {
    path,
    actor: i.user.id,
    at: Date.now(),
    result,
  };
  // Store no command arguments, attachments, embed bodies, confession identities or DM text.
  app.store.put(i.guildId!, 'commandReceipt', randomUUID(), receipt);
  if (detailed.has(i)) return;
  await app.audit(
    i.guildId!,
    'admin',
    'Command completed',
    `/${safe(path)}\n${safeMentions(receipt.result)}`,
    { force: true, profile: logProfile(app, i.user.id, i.member, i.user) },
  );
}
