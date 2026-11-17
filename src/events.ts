import { incomingDM } from './dm-conversations.js';
import { refreshSticky } from './sticky.js';
import { ticketChannelDeleted } from './ticket-categories.js';
import { roleMentionReply } from './role-mentions.js';
import { captureMemberChanges, memberAvatarChanged, userAvatarChanged } from './member-logs.js';
import { Events, PermissionFlagsBits as P, AuditLogEvent, type Message } from 'discord.js';
import type { App } from './types.js';
import { logError, safe, renderTemplate } from './util.js';
import { SpamDetector } from './spam.js';
import { checkHierarchy } from './permissions.js';
import { send } from './discord.js';
import { voiceEvent } from './modules/voice.js';
import {
  messageUpdated,
  messageDeleted,
  messagesBulkDeleted,
  messageLogExcludedChannel,
} from './message-logs.js';
import { channelSettingChanges } from './channel-logs.js';
import { onboardMember } from './modules/onboarding.js';
import { moderationNotice } from './dm.js';
import { channelNotice } from './notices.js';
import { mentionReply } from './mention-replies.js';
import { replyTextCommand } from './modules/text.js';
import { uwuMessage } from './uwulock.js';
import { honeypotMessage } from './honeypot.js';
import { memberDeparted, banObserved, observeModerationAudit } from './moderation-events.js';
import { caseDelivery } from './case-log.js';
import { logProfile } from './log-profile.js';
import {
  syncStarboard,
  removeStarboardMessage,
  starboardChannelChanged,
} from './modules/starboard.js';
const detector = new SpamDetector();
const joins = new Map<string, number[]>(),
  adminBursts = new Map<string, number[]>();

export function events(app: App) {
  // EventEmitter does not await handlers. Every handler has its own rejection boundary.
  const run = (context: string, fn: () => Promise<unknown>) => {
    void fn().catch((error) => logError(context, error));
  };
  const reactionChanged = (
    reaction: import('discord.js').MessageReaction | import('discord.js').PartialMessageReaction,
  ) => {
    if (
      reaction.message.guildId === app.guildId &&
      !reaction.emoji.id &&
      reaction.emoji.name?.replace(/\uFE0F/g, '') === '⭐'
    )
      run('starboard reaction', () => syncStarboard(app, reaction.message));
  };
  app.client.on(Events.MessageReactionAdd, reactionChanged);
  app.client.on(Events.MessageReactionRemove, reactionChanged);
  app.client.on(Events.MessageReactionRemoveEmoji, reactionChanged);
  app.client.on(Events.MessageReactionRemoveAll, (message) => {
    if (message.guildId === app.guildId)
      run('starboard reactions cleared', () => syncStarboard(app, message));
  });
  app.client.on(Events.ThreadDelete, (thread) => {
    if (thread.guildId === app.guildId)
      run('starboard thread deleted', () => starboardChannelChanged(app, thread.id, true));
  });
  app.client.on(Events.MessageCreate, (message) => {
    if (!message.guildId) {
      run('direct message relay', () => incomingDM(app, message));
      return;
    }
    if (message.guildId === app.guildId) run('message create', () => messageCreate(app, message));
  });
  app.client.on(Events.MessageUpdate, (old, message) => {
    if (message.guildId === app.guildId)
      run('message update', () => messageUpdated(app, old, message));
    if (message.guildId === app.guildId && app.store.get(app.guildId, 'starboardEntry', message.id))
      run('starboard edit', () => syncStarboard(app, message));
  });
  app.client.on(Events.MessageDelete, (message) => {
    if (message.guildId === app.guildId) run('message delete', () => messageDeleted(app, message));
    if (message.guildId === app.guildId)
      run('starboard delete', () => removeStarboardMessage(app, message));
  });
  app.client.on(Events.MessageBulkDelete, (messages, channel) => {
    if (channel.guildId === app.guildId)
      run('bulk delete log', () => messagesBulkDeleted(app, messages.values(), channel.id));
    if (channel.guildId === app.guildId)
      run('starboard bulk delete', async () => {
        for (const message of messages.values()) await removeStarboardMessage(app, message);
      });
  });
  app.client.on(Events.GuildMemberAdd, (member) => {
    if (member.guild.id === app.guildId)
      run('member join', async () => {
        const cfg = app.store.config(app.guildId);
        if (cfg.modules.stats) app.store.count(app.guildId, 'joins');
        await app.audit(
          app.guildId,
          'members',
          'Member joined',
          `Account created <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>.`,
          { profile: logProfile(app, member.id, member, member.user, true) },
        );
        await onboardMember(app, member, true);
        if (cfg.modules.automod) {
          const now = Date.now(),
            recent = (joins.get(app.guildId) ?? []).filter(
              (t) => t > now - cfg.automod.joinWindowSeconds * 1000,
            );
          recent.push(now);
          joins.set(app.guildId, recent);
          if (recent.length === cfg.automod.joinLimit)
            await app.audit(
              app.guildId,
              'automod',
              'Join burst alert',
              `${recent.length} joins in ${cfg.automod.joinWindowSeconds} seconds. Newest account age: ${Math.floor((now - member.user.createdTimestamp) / 86400000)} days. Review /panic if needed.`,
            );
          if (now - member.user.createdTimestamp < cfg.automod.youngAccountDays * 86400000)
            await app.audit(
              app.guildId,
              'automod',
              'New account joined',
              `Account younger than ${cfg.automod.youngAccountDays} days.`,
              { profile: logProfile(app, member.id, member) },
            );
        }
      });
  });
  app.client.on(Events.GuildMemberRemove, (member) => {
    if (member.guild.id === app.guildId)
      run('member leave', async () => {
        const cfg = app.store.config(app.guildId);
        if (cfg.modules.stats) app.store.count(app.guildId, 'leaves');
        memberDeparted(app, member);
        if (cfg.modules.onboarding) {
          const roles = member.roles.cache
            .filter(
              (r) =>
                cfg.restoreRoles.includes(r.id) &&
                !cfg.protectedRoles.includes(r.id) &&
                r.id !== cfg.verifiedRole &&
                !app.store.get(app.guildId, 'roleTimer', `${member.id}:${r.id}`),
            )
            .map((r) => r.id);
          app.store.put(app.guildId, 'roleRestore', member.id, { roles });
          if (cfg.welcomeChannel)
            await send(
              app,
              app.guildId,
              cfg.welcomeChannel,
              renderTemplate(cfg.goodbyeText, member.user, member.guild.name),
            );
        }
        app.store.delete(app.guildId, 'voiceActivity', member.id);
        app.store.delete(app.guildId, 'onboardingPending', member.id);
        app.store.delete(app.guildId, 'onboardingProgress', member.id);
      });
  });
  app.client.on(Events.GuildMemberUpdate, (old, member) => {
    if (member.guild.id === app.guildId) {
      const change = captureMemberChanges(app, old, member);
      run('member update', async () => {
        await memberAvatarChanged(app, old, member);
        if (old.pending && !member.pending) await onboardMember(app, member);
        if (change.nickname)
          await app.audit(app.guildId, 'members', 'Nickname changed', change.nickname, {
            profile: change.profile,
            dividers: true,
          });
      });
    }
  });
  app.client.on(Events.UserUpdate, (old, user) =>
    run('profile picture update', () => userAvatarChanged(app, old, user)),
  );
  app.client.on(Events.GuildBanRemove, (ban) => {
    if (ban.guild.id === app.guildId) {
      app.store.delete(app.guildId, 'banGeneration', ban.user.id);
      banObserved(app, ban.user.id, 'unban');
    }
  });
  app.client.on(Events.GuildBanAdd, (ban) => {
    if (ban.guild.id === app.guildId) banObserved(app, ban.user.id, 'ban');
  });
  app.client.on(Events.VoiceStateUpdate, (old, next) => {
    if (next.guild.id === app.guildId) run('voice event', () => voiceEvent(app, old, next));
  });
  app.client.on(Events.ChannelDelete, (channel) => {
    if (!channel.isDMBased() && channel.guild.id === app.guildId)
      run('ticket channel deleted', () => ticketChannelDeleted(app, channel));
    if (!channel.isDMBased() && channel.guild.id === app.guildId)
      run('starboard channel deleted', () => starboardChannelChanged(app, channel.id, true));
  });
  app.client.on(Events.ChannelUpdate, (old, channel) => {
    if (
      !channel.isDMBased() &&
      !old.isDMBased() &&
      channel.guild.id === app.guildId &&
      channelSettingChanges(old, channel).length
    )
      run('starboard channel changed', () => starboardChannelChanged(app, channel.id));
  });
  app.client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    if (guild.id === app.guildId)
      run('audit event', async () => {
        observeModerationAudit(app, entry);
        if (entry.executorId === app.client.user!.id) return;
        if (
          ![
            AuditLogEvent.ChannelDelete,
            AuditLogEvent.RoleDelete,
            AuditLogEvent.RoleUpdate,
            AuditLogEvent.WebhookCreate,
          ].includes(entry.action)
        )
          return;
        const key = `${guild.id}:${entry.executorId ?? 'unknown'}`,
          now = Date.now(),
          recent = (adminBursts.get(key) ?? []).filter((t) => t > now - 30000);
        recent.push(now);
        adminBursts.set(key, recent);
        if (recent.length === 5)
          await app.audit(
            app.guildId,
            'automod',
            'Suspicious administrative activity',
            'Five sensitive actions within 30 seconds. Review immediately. This alert does not roll changes back.',
            { profile: entry.executorId ? logProfile(app, entry.executorId) : undefined },
          );
        if (adminBursts.size > 500)
          for (const [k, v] of adminBursts)
            if (v[v.length - 1]! < now - 60000) adminBursts.delete(k);
      });
  });
  app.client.on(Events.AutoModerationActionExecution, (event) => {
    if (event.guild.id === app.guildId)
      run('native automod log', () =>
        app.audit(
          app.guildId,
          'automod',
          'Native AutoMod action',
          `Rule: ${safe(event.guild.autoModerationRules?.cache.get(event.ruleId)?.name ?? 'AutoMod rule')}\nAction: ${event.action.type === 1 ? 'Message blocked' : event.action.type === 2 ? 'Alert sent' : event.action.type === 3 ? 'Member timed out' : event.action.type === 4 ? 'Interaction blocked' : 'Action ' + event.action.type}`,
          {
            profile: logProfile(app, event.userId),
            footer: `Rule ${event.ruleId}`,
            reference:
              event.messageId && event.channelId
                ? `https://discord.com/channels/${app.guildId}/${event.channelId}/${event.messageId}`
                : event.channelId
                  ? `<#${event.channelId}>`
                  : undefined,
          },
        ),
      );
  });
}
async function messageCreate(app: App, message: Message) {
  if (!message.guild) return;
  if (await honeypotMessage(app, message)) return;
  await refreshSticky(app, message).catch((error) => logError('sticky refresh', error));
  if (message.author.bot || message.webhookId) return;
  const cfg = app.store.config(message.guild.id);
  let spamDetected = false;
  if (cfg.excludedChannels.includes(message.channelId)) return;
  if (cfg.modules.stats) {
    app.store.count(message.guild.id, 'messages');
    app.store.put(message.guild.id, 'activity', message.author.id, { last: Date.now() });
  }
  if (
    cfg.modules.logging &&
    cfg.snapshotDays > 0 &&
    !messageLogExcludedChannel(
      cfg,
      message.channelId,
      message.channel && 'parentId' in message.channel ? message.channel.parentId : undefined,
    )
  )
    app.store.snapshot(
      message.guild.id,
      message.channelId,
      message.id,
      message.author.id,
      message.content,
    );
  if (cfg.modules.automod) {
    const member = message.member ?? (await message.guild.members.fetch(message.author.id));
    if (
      !member.permissions.has(P.Administrator) &&
      !cfg.protectedRoles.some((r) => member.roles.cache.has(r)) &&
      !cfg.automod.exemptRoles.some((r) => member.roles.cache.has(r)) &&
      !cfg.automod.exemptChannels.includes(message.channelId)
    ) {
      const reason = detector.check(
        message.guild.id,
        {
          id: message.id,
          user: member.id,
          channel: message.channelId,
          content: message.content,
          mentions:
            message.mentions.users.size +
            message.mentions.roles.size +
            (message.mentions.everyone ? 1 : 0),
          attachments: message.attachments.size,
          time: Date.now(),
        },
        cfg.automod,
      );
      if (reason) {
        spamDetected = true;
        if (detector.shouldAlert(message.guild.id, member.id, Date.now()))
          await app
            .audit(
              message.guild.id,
              'automod',
              `Spam detected · ${cfg.automod.mode}`,
              `Reason: ${reason}`,
              { profile: logProfile(app, member.id, member), reference: message.url },
            )
            .catch((error) => logError('automod alert', error));
        if (cfg.automod.mode !== 'report') {
          const me = await message.guild.members.fetchMe();
          const botAsActor = me;
          try {
            checkHierarchy(botAsActor, member, me, message.guild.ownerId, cfg.protectedRoles);
            let deleted = false,
              timedOut = false;
            if (message.deletable) {
              await message.delete();
              deleted = true;
            }
            if (cfg.automod.mode === 'timeout' && member.moderatable) {
              await member.timeout(
                cfg.automod.timeoutMinutes * 60000,
                `Spam protection: ${reason}`,
              );
              timedOut = true;
            }
            if (!deleted && !timedOut)
              throw new Error(
                'Spam detected, but no moderation action could be applied. Check bot permissions and hierarchy.',
              );
            const caseId = app.store.addCase(
              message.guild.id,
              me.id,
              member.id,
              `automod:${timedOut ? 'timeout' : 'delete'}`,
              reason,
            );
            app.store.count(message.guild.id, 'moderation');
            const url = await app.audit(
              message.guild.id,
              'moderation',
              `Automatic action #${caseId}`,
              `Reason: ${reason}\nMessage deleted: ${deleted ? 'yes' : 'no'}${timedOut ? `\nTimeout: ${cfg.automod.timeoutMinutes} minutes\nMember DM: pending` : ''}`,
              {
                profile: logProfile(app, member.id, member),
                reference: deleted ? `<#${message.channelId}>` : message.url,
              },
            );
            if (timedOut)
              app.store.put(app.guildId, 'caseLog', String(caseId), {
                url: url || undefined,
                delivery: 'pending',
              });
            await channelNotice(
              app,
              message.guild.id,
              message.channelId,
              'moderation',
              `Automatic action #${caseId}`,
              `Member: <@${member.id}>\nTime: <t:${Math.floor(Date.now() / 1000)}:F>\nReason: ${safe(reason)}\nMessage deleted: ${deleted ? 'yes' : 'no'}${timedOut ? `\nTimeout: ${cfg.automod.timeoutMinutes} minutes.` : ''}`,
            );
            if (timedOut) {
              const delivery = await moderationNotice(
                app,
                message.guild.id,
                message.guild.name,
                member.id,
                'automatic timeout',
                `Spam protection: ${reason}`,
                `Case #${caseId}. Duration: ${cfg.automod.timeoutMinutes} minutes. Use /appeal case:${caseId} reason:YOUR_REASON in the server to appeal.`,
                false,
              );
              await caseDelivery(app, caseId, delivery);
            }
          } catch (error) {
            logError('automod enforcement', error);
          }
        }
      }
    }
  }
  const protectedMention = await roleMentionReply(app, message);
  if (
    !spamDetected &&
    !protectedMention &&
    !(await replyTextCommand(app, message)) &&
    !(await uwuMessage(app, message))
  )
    await mentionReply(app, message);
}
