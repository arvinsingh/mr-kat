import { randomUUID } from 'node:crypto';
import type { App, Interaction } from './types.js';
import { outcome } from './ui.js';
import { safe, safeMentions } from './util.js';
import { responsePolicies } from './response-policy.js';

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
  await app.audit(
    i.guildId!,
    'admin',
    'Command completed',
    `/${safe(path)} · <@${i.user.id}>\n${safeMentions(receipt.result)}`,
    { force: true },
  );
}
