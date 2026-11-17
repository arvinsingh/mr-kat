import { PermissionFlagsBits as P } from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Module, Interaction } from '../types.js';
import { requirePermission, enabled } from '../permissions.js';
import { assert, safe, safeMentions } from '../util.js';
import { reply } from '../ui.js';
import {
  evidenceSummary,
  resolveEvidence,
  evidenceChannelAccess,
  type MessageEvidence,
} from '../evidence.js';
import { revokeWarning } from '../warnings.js';
import { logProfile } from '../log-profile.js';
const reviewing = new Set<string>();
export async function submitReport(
  app: App,
  i: Interaction,
  target: string,
  reason: string,
  message?: MessageEvidence,
) {
  enabled(app, i.guildId!, 'tickets');
  const cfg = app.store.config(i.guildId!);
  assert(cfg.logs.reports, 'Staff need to configure the reports log destination first.');
  const key = randomUUID();
  const evidence = message && !cfg.excludedChannels.includes(message.channel) ? message : undefined;
  if (evidence?.capturedAt) await evidenceChannelAccess(app, i, evidence.channel);
  app.store.put(i.guildId!, 'reports', key, {
    actor: i.user.id,
    target,
    reason,
    message: evidence,
    status: 'open',
  });
  await app.audit(
    i.guildId!,
    'reports',
    'Member reported',
    `Reporter: <@${i.user.id}>\nReason: ${safeMentions(reason)}${evidence ? `\n---\n${evidenceSummary(evidence)}` : ''}`,
    { profile: logProfile(app, target), footer: `Report ${key}`, dividers: true },
  );
  await reply(i, `Your report was submitted privately. Reference: ${key}.`);
}
export const reports: Module = {
  commands: {
    report: async (app, i) =>
      submitReport(
        app,
        i,
        i.options.getUser('member', true).id,
        i.options.getString('reason', true),
        await resolveEvidence(app, i, i.options.getString('evidence')),
      ),
    appeal: async (app, i) => {
      enabled(app, i.guildId, 'moderation');
      assert(
        app.store.config(i.guildId).logs.reports,
        'Staff need to configure the reports destination.',
      );
      const caseId = i.options.getInteger('case', true),
        record = app.store.case(i.guildId, caseId);
      assert(
        record?.target === i.user.id,
        'You may only appeal your own retained moderation case.',
      );
      assert(
        !app.store.entriesMatching(i.guildId, 'appeals', { caseId }, 1).length,
        'An appeal for this case has already been submitted.',
      );
      const reason = i.options.getString('reason', true);
      app.store.put(i.guildId, 'appeals', randomUUID(), {
        caseId,
        actor: i.user.id,
        reason,
        status: 'open',
      });
      await app.audit(
        i.guildId,
        'reports',
        `Appeal for case #${caseId}`,
        `Reason: ${safeMentions(reason)}`,
        { profile: logProfile(app, i.user.id, i.member, i.user) },
      );
      await reply(i, 'Your appeal was submitted for staff review.');
    },
    review: async (app, i) => {
      await requirePermission(app, i, P.ModerateMembers);
      const kind = i.options.getString('kind', true);
      assert(kind === 'reports' || kind === 'appeals', 'Invalid review queue.');
      type Review = {
        actor: string;
        target?: string;
        reason: string;
        status: string;
        caseId?: number;
        decision?: string;
        reviewer?: string;
      };
      if (i.options.getSubcommand() === 'list') {
        const items = app.store.entriesMatching<Review>(i.guildId, kind, { status: 'open' }, 10);
        await reply(
          i,
          items
            .map(
              (e) =>
                `${e.key}\nBy <@${e.data.actor}>${e.data.target ? ` · Target <@${e.data.target}>` : ''}${e.data.caseId ? ` · Case #${e.data.caseId}` : ''}\n${safe(e.data.reason, 180)}`,
            )
            .join('\n\n') || 'No pending submissions.',
        );
        return;
      }
      const key = i.options.getString('id', true),
        item = app.store.get<Review>(i.guildId, kind, key);
      assert(item, 'Submission not found.');
      assert(item.status === 'open', 'This submission has already been resolved.');
      const reviewKey = `${i.guildId}:${kind}:${key}`;
      assert(!reviewing.has(reviewKey), 'This submission is already being reviewed.');
      reviewing.add(reviewKey);
      try {
        item.status = i.options.getString('decision', true);
        item.decision = i.options.getString('reason', true);
        item.reviewer = i.user.id;
        let revoked = false;
        if (
          kind === 'appeals' &&
          item.status === 'accepted' &&
          item.caseId &&
          app.store.case(i.guildId, item.caseId)?.action === 'warn'
        ) {
          if (!app.store.get(i.guildId, 'warningRevocation', String(item.caseId)))
            await revokeWarning(app, i, item.caseId, item.decision, key);
          revoked = true;
        }
        app.store.put(i.guildId, kind, key, item);
        await app.audit(
          i.guildId,
          'reports',
          `${kind === 'reports' ? 'Report' : 'Appeal'} ${item.status}`,
          `Reviewed by: <@${i.user.id}>${item.target ? `\nReporter: <@${item.actor}>` : ''}\nReason: ${safeMentions(item.decision)}`,
          {
            profile: logProfile(app, item.target ?? item.actor),
            footer: `${kind === 'reports' ? 'Report' : 'Appeal'} ${key}${item.caseId ? ' · Case #' + item.caseId : ''}`,
          },
        );
        await reply(
          i,
          revoked
            ? 'Appeal accepted. The warning is revoked and no longer counts toward escalation. Previous kicks/timeouts are not automatically reversed.'
            : 'Decision recorded. For non-warning cases, use /mod to explicitly change any punishment.',
        );
      } finally {
        reviewing.delete(reviewKey);
      }
    },
  },
  component: async (app, i) => {
    if (i.isModalSubmit() && i.customId.startsWith('report:')) {
      const key = i.customId.split(':')[1]!;
      const pending = app.store.get<{
        actor: string;
        target: string;
        message: { id: string; channel: string; content: string; url: string };
        expires: number;
      }>(i.guildId, 'reportDraft', key);
      assert(
        pending && pending.actor === i.user.id && pending.expires > Date.now(),
        'This report form expired.',
      );
      app.store.delete(i.guildId, 'reportDraft', key);
      await submitReport(
        app,
        i,
        pending.target,
        i.fields.getTextInputValue('reason'),
        pending.message,
      );
      return true;
    }
    return false;
  },
};
