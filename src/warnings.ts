import { PermissionFlagsBits as P } from 'discord.js';
import type { App, Interaction } from './types.js';
import type { Case } from './store.js';
import { assert, safeMentions } from './util.js';
import { enabled, requirePermission } from './permissions.js';
import { moderationNotice } from './dm.js';
import { channelNotice } from './notices.js';
import { exclusive } from './concurrency.js';
import { logProfile } from './log-profile.js';

export interface WarningRevocation {
  actor: string;
  reason: string;
  created: number;
  appeal?: string;
}
export interface WarningTrigger {
  caseId: number;
  ids: number[];
  threshold: number;
}
export function warningHistory(app: App, guild: string, target: string) {
  const now = Date.now();
  const rows = app.store.warningCases<WarningRevocation>(guild, target).map((record) => {
    const { revoked, expires } = record;
    const status = revoked
      ? 'revoked'
      : expires !== undefined && expires <= now
        ? 'expired'
        : 'active';
    return { ...record, revoked, expires, status };
  });
  return {
    rows,
    total: rows.length,
    active: rows.filter((row) => row.status === 'active'),
    expired: rows.filter((row) => row.status === 'expired').length,
    revoked: rows.filter((row) => row.status === 'revoked').length,
  };
}

// Serialize new warnings per member, while allowing appeals/revocations during DM delivery.
export function withWarningLock<T>(
  app: App,
  guild: string,
  target: string,
  work: () => Promise<T>,
) {
  return exclusive(
    app,
    `warning:${guild}:${target}`,
    'A warning for this member is already being processed.',
    work,
  );
}

export function validateWarningKick(
  app: App,
  guild: string,
  target: string,
  trigger: WarningTrigger,
) {
  const cfg = app.store.config(guild),
    active = warningHistory(app, guild, target).active;
  assert(
    cfg.warningAction === 'kick' &&
      cfg.warningThreshold > 0 &&
      cfg.warningThreshold === trigger.threshold,
    'The warning policy changed; automatic kick cancelled.',
  );
  assert(
    active.length >= cfg.warningThreshold &&
      active.some((row) => row.id === trigger.caseId) &&
      trigger.ids.every((id) => active.some((row) => row.id === id)),
    'Warnings expired or were revoked; automatic kick cancelled.',
  );
}

export async function revokeWarning(
  app: App,
  i: Interaction,
  caseId: number,
  reason: string,
  appeal?: string,
) {
  enabled(app, i.guildId!, 'moderation');
  await requirePermission(app, i, P.ModerateMembers);
  const record = app.store.case(i.guildId!, caseId);
  assert(record?.action === 'warn', 'Choose an existing warning case.');
  assert(reason.trim(), 'A revocation reason is required.');
  assert(
    !app.store.get(i.guildId!, 'warningRevocation', String(caseId)),
    'This warning has already been revoked.',
  );
  app.store.transaction(() => {
    app.store.put(i.guildId!, 'warningRevocation', String(caseId), {
      actor: i.user.id,
      reason,
      created: Date.now(),
      ...(appeal ? { appeal } : {}),
    } satisfies WarningRevocation);
    app.store.addCase(
      i.guildId!,
      i.user.id,
      record.target,
      'warning-revoked',
      `Warning #${caseId}: ${reason}`,
    );
  });
  const active = warningHistory(app, i.guildId!, record.target).active.length;
  await channelNotice(
    app,
    i.guildId!,
    i.channelId!,
    'moderation',
    `Warning #${caseId} revoked`,
    `Member: <@${record.target}>\nReason: ${safeMentions(reason)}\nActive warnings: ${active}. The original record is preserved. Existing kicks/timeouts are not automatically reversed.`,
  );
  const dm = await moderationNotice(
    app,
    i.guildId!,
    i.guild!.name,
    record.target,
    'Warning revoked',
    reason,
    `Warning #${caseId} no longer counts toward automatic escalation. Active warnings: ${active}. The original record remains in history.`,
    false,
  );
  await app.audit(
    i.guildId!,
    'moderation',
    `Warning #${caseId} revoked`,
    `Staff: <@${i.user.id}>\nReason: ${safeMentions(reason)}\nActive warnings: ${active}\nMember DM: ${dm}${appeal ? '\nAppeal: ' + appeal : ''}`,
    { force: true, profile: logProfile(app, record.target) },
  );
  return { record: record as Case, active, dm };
}
