import {
  AttachmentBuilder,
  PermissionFlagsBits as P,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Command, Module, Interaction } from '../types.js';
import {
  enabled,
  manageableMember,
  requirePermission,
  botPermission,
  checkHierarchy,
} from '../permissions.js';
import { assert, duration, safe, safeMentions, parseIds } from '../util.js';
import { confirm, embed, reply, noMentions, type Confirmation } from '../ui.js';
import { id } from '../config.js';
import { textChannel } from '../discord.js';
import { moderationNotice } from '../dm.js';
import { channelNotice } from '../notices.js';
import {
  resolveEvidence,
  evidenceText,
  evidenceChannelAccess,
  type MessageEvidence,
} from '../evidence.js';
import {
  warningHistory,
  validateWarningKick,
  withWarningLock,
  type WarningTrigger,
} from '../warnings.js';

interface Approval {
  actor: string;
  payload: Record<string, unknown>;
  expires: number;
  channel: string;
  message: string;
}
async function executeModeration(
  app: App,
  i: Interaction,
  payload: Record<string, unknown>,
  originalActor?: string,
) {
  enabled(app, i.guildId!, 'moderation');
  const { target, reason, action, expires } = payload as {
    target: string;
    reason: string;
    action: string;
    expires?: number;
  };
  const permission = action === 'ban' ? P.BanMembers : P.KickMembers;
  const trigger = payload.warningTrigger as WarningTrigger | undefined;
  const actorPermission = trigger && !originalActor ? P.ModerateMembers : permission;
  const authorize = async () => {
    const member = await manageableMember(app, i, target, actorPermission);
    await botPermission(i.guild!, permission);
    if (trigger) {
      validateWarningKick(app, i.guildId!, target, trigger);
      assert(
        !app.store.config(i.guildId!).secondApproval || originalActor,
        'Second-staff approval is now required; automatic kick cancelled.',
      );
    }
    return member;
  };
  let member = await authorize();
  const checkRequester = async () => {
    if (!originalActor) return;
    const actor = await i.guild!.members.fetch(originalActor);
    const me = await botPermission(i.guild!, permission);
    assert(
      actor.permissions.has(trigger ? P.ModerateMembers : permission),
      'The requesting staff member is no longer authorized.',
    );
    const cfg = app.store.config(i.guildId!);
    assert(
      actor.id === i.guild!.ownerId ||
        !cfg.staffRoles.length ||
        cfg.staffRoles.some((role) => actor.roles.cache.has(role)),
      'The requester is no longer on the staff allowlist.',
    );
    checkHierarchy(actor, member, me, i.guild!.ownerId, cfg.protectedRoles);
  };
  await checkRequester();
  const evidence = payload.evidence as MessageEvidence | undefined;
  if (evidence) {
    await evidenceChannelAccess(app, i, evidence.channel);
    if (originalActor) await evidenceChannelAccess(app, i, evidence.channel, originalActor);
  }
  const delivery = await moderationNotice(
    app,
    i.guildId!,
    i.guild!.name,
    target,
    `${action} approved`,
    reason,
    `${expires ? `Duration: ${Math.ceil(expires / 60000)} minutes.\n` : ''}Removal will be attempted next. If it succeeds, contact server staff outside the server for an appeal.`,
  );
  // A DM can take time; recheck authority before removing the member.
  enabled(app, i.guildId!, 'moderation');
  member = await authorize();
  await checkRequester();
  if (trigger) validateWarningKick(app, i.guildId!, target, trigger);
  if (action === 'kick') await member.kick(reason);
  else {
    const marker = randomUUID(),
      banReason = `${reason.slice(0, 350)} [mr-kat:${marker}]`;
    if (expires) {
      app.store.put(i.guildId!, 'banGeneration', target, { marker, reason: banReason });
      app.store.job(
        i.guildId!,
        originalActor ?? i.user.id,
        'unban',
        { target, marker, reason: banReason },
        Date.now() + expires,
      );
    }
    await member.ban({ reason: banReason });
  }
  const caseId = await record(
    app,
    i,
    target,
    action,
    reason,
    String(payload.originChannel ?? i.channelId),
    payload.evidence as MessageEvidence | undefined,
    originalActor,
  );
  if (trigger)
    app.store.put(i.guildId!, 'warningEscalation', String(trigger.caseId), {
      action,
      state: 'completed',
      caseId,
    });
  await reply(
    i,
    `${trigger ? `Warning #${trigger.caseId} recorded. Automatic ` : 'Completed '}${action}. Case #${caseId}. DM: ${delivery}.`,
  );
}

async function record(
  app: App,
  i: Interaction,
  target: string,
  action: string,
  reason: string,
  channel = i.channelId!,
  evidence?: MessageEvidence,
  requester?: string,
  warningExpires?: number,
) {
  const caseId = app.store.addCase(i.guildId!, i.user.id, target, action, reason);
  if (action === 'warn' && warningExpires)
    app.store.put(i.guildId!, 'warningExpiry', String(caseId), { expires: warningExpires });
  if (evidence)
    app.store.put(i.guildId!, 'caseEvidence', String(caseId), { actor: i.user.id, evidence });
  app.store.count(i.guildId!, 'moderation');
  await app.audit(
    i.guildId!,
    'moderation',
    `Case #${caseId}: ${action}`,
    `Member: <@${target}>\nStaff: <@${i.user.id}>\nReason: ${safeMentions(reason || 'No reason supplied.')}${requester ? `\nRequested by: <@${requester}> · Approved by: <@${i.user.id}>` : ''}${evidence ? `\n${evidenceText(evidence)}` : ''}`,
  );
  await channelNotice(
    app,
    i.guildId!,
    channel,
    'moderation',
    `Case #${caseId}: ${action}`,
    `Member: <@${target}> (ID: ${target})\nTime: <t:${Math.floor(Date.now() / 1000)}:F>\nReason: ${safeMentions(reason || 'No reason supplied.')}`,
  );
  return caseId;
}
export async function moderateWithEvidence(
  app: App,
  i: Interaction,
  action: string,
  target: string,
  reason: string,
  lifetime?: string,
  evidence?: MessageEvidence,
) {
  const work = () => performModeration(app, i, action, target, reason, lifetime, evidence);
  return action === 'warn' ? withWarningLock(app, i.guildId!, target, work) : work();
}
async function performModeration(
  app: App,
  i: Interaction,
  action: string,
  target: string,
  reason: string,
  lifetime?: string,
  evidence?: MessageEvidence,
) {
  enabled(app, i.guildId!, 'moderation');
  assert(
    ['warn', 'timeout', 'untimeout', 'kick', 'ban'].includes(action),
    'Invalid moderation action.',
  );
  assert(reason.trim().length > 0, 'A reason is required.');
  if (evidence) await evidenceChannelAccess(app, i, evidence.channel);
  const member = await manageableMember(
    app,
    i,
    target,
    action === 'ban' ? P.BanMembers : action === 'kick' ? P.KickMembers : P.ModerateMembers,
  );
  if (action === 'kick' || action === 'ban') {
    const expires = lifetime ? duration(lifetime) : undefined;
    await confirm(
      app,
      i,
      action +
        ' ' +
        safe(member.user.tag) +
        '?\nReason: ' +
        safe(reason) +
        (evidence ? '\nEvidence: ' + evidence.url : ''),
      'moderate',
      {
        target,
        reason,
        action,
        ...(expires ? { expires } : {}),
        ...(evidence ? { evidence } : {}),
      },
    );
    return;
  }
  const expiry = lifetime
    ? duration(lifetime, action === 'timeout' ? 28 * 86400000 : undefined)
    : undefined;
  if (action === 'timeout') {
    assert(expiry, 'A timeout duration is required.');
    await member.timeout(expiry, reason);
  }
  if (action === 'untimeout') await member.timeout(null, reason);
  const caseId = await record(
    app,
    i,
    target,
    action,
    reason,
    i.channelId!,
    evidence,
    undefined,
    action === 'warn' && expiry ? Date.now() + expiry : undefined,
  );
  const active =
    action === 'warn' ? warningHistory(app, i.guildId!, target).active.length : undefined;
  const delivery = await moderationNotice(
    app,
    i.guildId!,
    i.guild!.name,
    target,
    action,
    reason,
    'Case #' +
      caseId +
      '.' +
      (action === 'timeout' ? ' Duration: ' + safe(lifetime, 40) + '.' : '') +
      (active !== undefined ? ` Active warnings: ${active}.` : '') +
      ' Use /appeal case:' +
      caseId +
      ' reason:YOUR_REASON in the server to appeal.',
  );
  let escalation = '';
  if (action === 'warn') {
    const cfg = app.store.config(i.guildId!),
      history = warningHistory(app, i.guildId!, target);
    if (
      cfg.warningThreshold > 0 &&
      cfg.warningAction !== 'none' &&
      history.active.length >= cfg.warningThreshold &&
      history.active.some((row) => row.id === caseId)
    ) {
      try {
        if (cfg.warningAction === 'kick') {
          const warningTrigger: WarningTrigger = {
            caseId,
            ids: history.active.map((row) => row.id),
            threshold: cfg.warningThreshold,
          };
          app.store.put(i.guildId!, 'warningEscalation', String(caseId), {
            action: 'kick',
            state: 'attempting',
          });
          await moderationConfirmation(app, i, {
            actor: i.user.id,
            channel: i.channelId!,
            expires: Date.now() + 300000,
            kind: 'moderate',
            payload: {
              action: 'kick',
              target,
              reason: `Warning policy: ${history.active.length} active warnings (threshold ${cfg.warningThreshold}); warning #${caseId}.`,
              warningTrigger,
            },
          });
          return;
        }
        const current = await manageableMember(app, i, target, P.ModerateMembers);
        const fresh = app.store.config(i.guildId!);
        assert(
          fresh.warningAction === 'timeout' &&
            fresh.warningThreshold === cfg.warningThreshold &&
            warningHistory(app, i.guildId!, target).active.length >= fresh.warningThreshold,
          'Warning policy changed or active warning count fell; timeout cancelled.',
        );
        await current.timeout(
          cfg.warningTimeoutMinutes * 60000,
          'Configured warning threshold reached',
        );
        const timeoutCase = await record(
          app,
          i,
          target,
          'warning-threshold',
          `${history.active.length} active warnings; ${cfg.warningTimeoutMinutes} minute timeout.`,
        );
        await moderationNotice(
          app,
          i.guildId!,
          i.guild!.name,
          target,
          'Automatic warning timeout',
          `${history.active.length} active warnings reached the configured threshold.`,
          `Case #${timeoutCase}. Duration: ${cfg.warningTimeoutMinutes} minutes. You can appeal individual warnings using /appeal.`,
        );
        escalation = ` Automatic ${cfg.warningTimeoutMinutes}-minute timeout applied.`;
      } catch (error) {
        app.store.put(i.guildId!, 'warningEscalation', String(caseId), {
          action: cfg.warningAction,
          state: 'not-confirmed',
        });
        await app.audit(
          i.guildId!,
          'moderation',
          'Warning escalation not confirmed',
          `Warning #${caseId} for <@${target}> was saved. ${safeMentions(error instanceof Error ? error.message : 'Discord request failed')}. Inspect the member before retrying; no automatic replay.`,
          { force: true },
        );
        escalation =
          ' Warning saved, but automatic escalation could not be confirmed. Check staff logs and the member before retrying.';
      }
    }
  }
  await reply(
    i,
    'Recorded ' +
      action +
      '. Case #' +
      caseId +
      '. DM: ' +
      delivery +
      '.' +
      (active !== undefined
        ? ` Active warnings: ${warningHistory(app, i.guildId!, target).active.length}.`
        : '') +
      escalation,
  );
}

export async function moderationConfirmation(app: App, i: Interaction, pending: Confirmation) {
  enabled(app, i.guildId!, 'moderation');
  const { target, reason, action, expires } = pending.payload as {
    target: string;
    reason: string;
    action: string;
    expires?: number;
  };
  const trigger = pending.payload.warningTrigger as WarningTrigger | undefined;
  await manageableMember(
    app,
    i,
    target,
    trigger ? P.ModerateMembers : action === 'ban' ? P.BanMembers : P.KickMembers,
  );
  if (trigger) {
    await botPermission(i.guild!, P.KickMembers);
    validateWarningKick(app, i.guildId!, target, trigger);
  }
  if (app.store.config(i.guildId!).secondApproval) {
    const channelId = app.store.config(i.guildId!).logs.moderation;
    assert(channelId, 'Configure the moderation log destination before enabling secondApproval.');
    const channel = await textChannel(app, i.guildId!, channelId);
    const key = randomUUID();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approveMod:${key}`)
        .setLabel('Approve (different staff member)')
        .setStyle(ButtonStyle.Danger),
    );
    const message = await channel.send({
      embeds: [
        embed(
          'Moderation approval requested',
          `<@${i.user.id}> requests ${action} for <@${target}>.\n${safe(reason)}\nExpires in 10 minutes.`,
          'warning',
        ),
      ],
      components: [row],
      allowedMentions: noMentions,
    });
    app.store.put(i.guildId!, 'approval', key, {
      actor: i.user.id,
      payload: { ...pending.payload, originChannel: pending.channel },
      expires: Date.now() + 600000,
      channel: channel.id,
      message: message.id,
    } satisfies Approval);
    if (trigger)
      app.store.put(i.guildId!, 'warningEscalation', String(trigger.caseId), {
        action: 'kick',
        state: 'pending-approval',
        approval: key,
      });
    await reply(
      i,
      `${trigger ? `Warning #${trigger.caseId} recorded; automatic kick requested. ` : ''}Sent to the moderation log for a different staff member to approve.`,
    );
    return;
  }
  await executeModeration(app, i, { ...pending.payload, originChannel: pending.channel });
}
export const moderation: Module = {
  commands: {
    mod: async (app, i) => {
      enabled(app, i.guildId, 'moderation');
      const action = i.options.getSubcommand();
      const user = i.options.getUser('member');
      const reason = i.options.getString('reason') ?? '';
      if (action === 'nickname') {
        const member = await manageableMember(
            app,
            i,
            i.options.getUser('member', true).id,
            P.ManageNicknames,
          ),
          name = i.options.getString('name', true);
        assert(name.length <= 32, 'Nicknames must be at most 32 characters.');
        await member.setNickname(name, reason);
        await record(app, i, member.id, 'nickname', reason);
        await reply(i, 'Nickname updated.');
        return;
      }
      if (action === 'bulk-nickname') {
        const targets = parseIds(i.options.getString('members', true)),
          template = i.options.getString('template', true);
        assert(template.length <= 64, 'Keep nickname templates under 64 characters.');
        for (const target of targets) await manageableMember(app, i, target, P.ManageNicknames);
        await confirm(
          app,
          i,
          `Change nicknames for ${targets.length} selected members?\nTemplate: ${safe(template)}\nGenerated names are capped at 32 characters.`,
          'batchNicknames',
          { targets, template, reason },
        );
        return;
      }
      if (['warn', 'timeout', 'untimeout', 'kick', 'ban'].includes(action)) {
        assert(user, 'Select a member.');
        const evidence = await resolveEvidence(app, i, i.options.getString('evidence'));
        await moderateWithEvidence(
          app,
          i,
          action,
          user.id,
          reason,
          i.options.getString(action === 'warn' ? 'expires' : 'duration') ?? undefined,
          evidence,
        );
        return;
      }
      if (action === 'evidence') {
        await requirePermission(app, i, P.ModerateMembers);
        const saved = app.store.get<{ evidence: MessageEvidence }>(
          i.guildId,
          'caseEvidence',
          String(i.options.getInteger('case', true)),
        );
        assert(saved, 'No retained message evidence for this case.');
        await reply(i, {
          files: [
            new AttachmentBuilder(Buffer.from(evidenceText(saved.evidence)), {
              name: 'case-evidence.txt',
            }),
          ],
        });
        return;
      }
      if (action === 'unban') {
        await requirePermission(app, i, P.BanMembers);
        await botPermission(i.guild, P.BanMembers);
        const target = id.parse(i.options.getString('user_id', true));
        const actor = await i.guild.members.fetch(i.user.id);
        const banned = await i.guild.bans.fetch(target);
        assert(banned, 'This user is not banned.');
        assert(
          actor.id === i.guild.ownerId || actor.roles.highest.position > 0,
          'Insufficient role hierarchy.',
        );
        await i.guild.bans.remove(target, reason);
        app.store.delete(i.guildId, 'banGeneration', target);
        const caseId = await record(app, i, target, 'unban', reason);
        const delivery = await moderationNotice(
          app,
          i.guildId,
          i.guild.name,
          target,
          'unban',
          reason,
          `Case #${caseId}. Contact staff if you need a new invitation.`,
        );
        await reply(i, `Unbanned. Case #${caseId}. DM: ${delivery}.`);
        return;
      }
      await requirePermission(app, i, P.ModerateMembers);
      if (action === 'note') {
        assert(user, 'Select a member.');
        const text = i.options.getString('text', true);
        const key = randomUUID();
        app.store.put(i.guildId, 'notes', key, { target: user.id, actor: i.user.id, text });
        await reply(i, `Private note saved: ${key}.`);
        return;
      }
      if (action === 'amend') {
        const caseId = i.options.getInteger('case', true);
        assert(app.store.case(i.guildId, caseId), 'Case not found.');
        app.store.put(i.guildId, 'caseAmendments', randomUUID(), {
          caseId,
          actor: i.user.id,
          text: i.options.getString('text', true),
        });
        await reply(i, 'Correction appended. The original record is preserved.');
        return;
      }
      if (action === 'summary') {
        const cases = app.store.cases(i.guildId, undefined, 1000);
        const actors = new Map<string, number>();
        for (const item of cases) actors.set(item.actor, (actors.get(item.actor) ?? 0) + 1);
        await reply(
          i,
          `Staff actions in the latest ${cases.length} retained cases:\n${[...actors].map(([actor, count]) => `<@${actor}>: ${count}`).join('\n') || 'None.'}`,
        );
        return;
      }
      if (action === 'info') {
        assert(user, 'Select a member.');
        const member = await i.guild.members.fetch(user.id);
        const warnings = warningHistory(app, i.guildId, user.id);
        const notes = app.store
          .entries<{ target: string; actor: string; text: string }>(i.guildId, 'notes')
          .filter((e) => e.data.target === user.id)
          .slice(0, 5);
        await reply(i, {
          embeds: [
            embed(
              safe(user.tag, 200) +
                ` · ${warnings.active.length} active warnings (${warnings.total} retained)`,
              `User ID: ${user.id}\nAccount created: <t:${Math.floor(user.createdTimestamp / 1000)}:f>\nJoined: ${member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:f>` : 'Unknown'}\nRoles: ${member.roles.cache
                .filter((r) => r.id !== i.guildId)
                .map((r) => safe(r.name, 60))
                .join(', ')
                .slice(
                  0,
                  900,
                )}\nRecent staff notes:\n${notes.map((e) => `${safe(e.data.text, 250)} — <@${e.data.actor}>`).join('\n') || 'None.'}`,
            ),
          ],
        });
        return;
      }
      const cases = app.store.cases(i.guildId, user?.id, action === 'export' ? 1000 : 15);
      const amendments = app.store
        .entries(i.guildId, 'caseAmendments')
        .filter((e) => cases.some((c) => c.id === (e.data as { caseId: number }).caseId));
      if (action === 'export') {
        await reply(i, {
          files: [
            new AttachmentBuilder(Buffer.from(JSON.stringify({ cases, amendments }, null, 2)), {
              name: 'moderation-cases.json',
            }),
          ],
        });
        return;
      }
      await reply(
        i,
        cases
          .map((c) => {
            const revoked =
              c.action === 'warn' && app.store.get(i.guildId, 'warningRevocation', String(c.id));
            const expiry = app.store.get<{ expires: number }>(
              i.guildId,
              'warningExpiry',
              String(c.id),
            );
            return `#${c.id} ${c.action}${revoked ? ' · revoked' : ''} · <@${c.target}> · <@${c.actor}>${expiry ? ` · ${expiry.expires < Date.now() ? 'expired' : 'expires'} <t:${Math.floor(expiry.expires / 1000)}:R>` : ''}\n${safe(c.reason, 150)}`;
          })
          .join('\n') || 'No cases found.',
      );
    },
  },
  component: async (app, i) => {
    if (!i.isButton() || !i.customId.startsWith('approveMod:')) return false;
    const key = i.customId.split(':')[1]!;
    const pending = app.store.get<Approval>(i.guildId, 'approval', key);
    assert(
      pending &&
        pending.expires > Date.now() &&
        pending.message === i.message.id &&
        pending.channel === i.channelId,
      'This approval request expired.',
    );
    assert(pending.actor !== i.user.id, 'A different staff member must approve this action.');
    await manageableMember(
      app,
      i,
      String(pending.payload.target),
      pending.payload.action === 'ban' ? P.BanMembers : P.KickMembers,
    );
    // Remove the request synchronously before awaiting the operation so concurrent clicks cannot approve twice.
    assert(app.store.get(i.guildId, 'approval', key), 'This request was already handled.');
    app.store.delete(i.guildId, 'approval', key);
    try {
      await executeModeration(app, i, pending.payload, pending.actor);
    } finally {
      await i.message.edit({ components: [], allowedMentions: noMentions }).catch(() => undefined);
    }
    return true;
  },
};
