import { ChannelType, ChannelFlags, PermissionFlagsBits as P } from 'discord.js';
import type { App, Component, Interaction, Module } from '../types.js';
import { assert, errorText } from '../util.js';
import { owner, requirePermission, botPermission, checkHierarchy } from '../permissions.js';
import { reply, noMentions } from '../ui.js';
import { sendModern, modernEdit } from '../presentation.js';
import {
  honeypotLog,
  honeypotWarning,
  updateHoneypotReport,
  type HoneypotIncident,
} from '../honeypot.js';
import { serial } from '../concurrency.js';
import { logProfile } from '../log-profile.js';

export async function releaseHoneypot(app: App, i: Interaction, id: string, button?: Component) {
  await requirePermission(app, i, P.ModerateMembers);
  return serial(app, `honeypot-incident:${id}`, async () => {
    const item = app.store.get<HoneypotIncident>(app.guildId, 'honeypotIncident', id);
    assert(item && !item.released, 'This incident was already released or is no longer retained.');
    if (button)
      assert(
        item.report?.message === button.message?.id && item.report?.channel === button.channelId,
        'Use the original private incident controls.',
      );
    const actor = await requirePermission(app, i, P.ModerateMembers);
    const me = await botPermission(i.guild, P.ModerateMembers);
    const member = await i.guild.members.fetch({ user: item.user, force: true }).catch((error) => {
      if ((error as { code?: number }).code === 10007) return null;
      throw error;
    });
    if (member)
      checkHierarchy(
        actor,
        member,
        me,
        i.guild.ownerId,
        app.store.config(app.guildId).protectedRoles,
      );
    const current = member?.communicationDisabledUntilTimestamp ?? 0;
    assert(
      current <= Date.now() || item.ownsTimeout !== false,
      'This incident preserved an existing timeout. Review it with /mod before removing it.',
    );
    assert(
      current <= Date.now() || current === item.timeoutUntil,
      'A different timeout is now active. Review it with /mod before removing it.',
    );
    item.releaseStarted = true;
    app.store.put(app.guildId, 'honeypotIncident', id, item);
    if (member && current > Date.now())
      await member.disableCommunicationUntil(null, 'Honeypot incident released after staff review');
    const latest = app.store.get<HoneypotIncident>(app.guildId, 'honeypotIncident', id)!;
    latest.released = true;
    latest.scan = latest.scan === 'done' ? 'done' : 'cancelled';
    app.store.put(app.guildId, 'honeypotIncident', id, latest);
    const active = app.store.get<{ incident: string }>(app.guildId, 'honeypotActive', item.user);
    if (active?.incident === id) app.store.delete(app.guildId, 'honeypotActive', item.user);
    await updateHoneypotReport(app, id);
    if (await honeypotLog(app).catch(() => null))
      await app.audit(
        app.guildId,
        'moderation',
        'Honeypot incident released',
        `Staff: <@${i.user.id}>\nPending cleanup stopped; deleted messages cannot be restored.`,
        { force: true, profile: logProfile(app, item.user), footer: `Incident ${id}` },
      );
    await reply(
      i,
      'Honeypot timeout released. Remaining cleanup stopped. Deleted messages cannot be restored.',
    );
  });
}
export const honeypot: Module = {
  commands: {
    honeypot: async (app, i) => {
      const action = i.options.getSubcommand();
      if (action === 'release')
        return releaseHoneypot(app, i, i.options.getString('incident', true));
      if (action === 'status') {
        await requirePermission(app, i, P.ModerateMembers);
        const cfg = app.store.config(i.guildId),
          setting = cfg.honeypot;
        const recent = app.store.entries<HoneypotIncident>(i.guildId, 'honeypotIncident', 5);
        await reply(
          i,
          `**Honeypot · ${setting.enabled ? 'enabled' : 'disabled'}**\nChannel: ${setting.channel ? `<#${setting.channel}> (#honeypot)` : 'not configured'}\nCleanup: ${setting.cleanupMinutes} minutes · Timeout: ${setting.timeoutDays} days · Spoiler: ${setting.spoiler}\n${!cfg.modules.automod || !cfg.modules.moderation || !cfg.modules.messages ? 'Enable automod, moderation and messages for enforcement.\n' : ''}Recent incidents:\n${recent.map(({ data }) => `${data.id} · <@${data.user}> · ${data.released ? 'released' : data.timeout} · scan ${data.scan}, ${data.completed.length}/${data.jobs.length} purges processed, ${data.skipped} issues`).join('\n') || 'None.'}`,
        );
        return;
      }
      owner(i);
      await serial(app, 'honeypot-setup', async () => {
        const cfg = app.store.config(i.guildId);
        if (action === 'disable') {
          cfg.honeypot.enabled = false;
          app.store.setConfig(i.guildId, cfg, i.user.id);
          for (const { data: item } of app.store.entriesMatching<HoneypotIncident>(
            i.guildId,
            'honeypotIncident',
            { released: false },
            2147483647,
          )) {
            item.cleanupStopped = true;
            if (item.scan !== 'done') item.scan = 'cancelled';
            app.store.put(i.guildId, 'honeypotIncident', item.id, item);
          }
          const saved =
            cfg.honeypot.channel &&
            app.store.get<{ message: string; armed: boolean }>(
              i.guildId,
              'honeypotChannel',
              cfg.honeypot.channel,
            );
          if (cfg.honeypot.channel && saved) {
            saved.armed = false;
            app.store.put(i.guildId, 'honeypotChannel', cfg.honeypot.channel, saved);
            try {
              const channel = await i.guild.channels.fetch(cfg.honeypot.channel);
              if (channel?.isTextBased())
                await (
                  await channel.messages.fetch(saved.message)
                ).edit(
                  modernEdit({ components: [honeypotWarning(false)], allowedMentions: noMentions }),
                );
            } catch (error) {
              await reply(
                i,
                'Honeypot disabled. Its old warning could not be updated: ' + errorText(error),
              );
              return;
            }
          }
          await reply(i, 'Honeypot disabled. Pending cleanup stops; existing timeouts remain.');
          return;
        }
        assert(action === 'setup', 'Unknown honeypot action.');
        assert(
          cfg.modules.automod && cfg.modules.moderation && cfg.modules.messages,
          'Enable the automod, moderation and messages modules first.',
        );
        await botPermission(i.guild, [P.ManageChannels, P.ModerateMembers, P.ManageMessages]);
        await honeypotLog(app);
        let channel = cfg.honeypot.channel
          ? await i.guild.channels.fetch(cfg.honeypot.channel).catch((error) => {
              if ((error as { code?: number }).code === 10003) return null;
              throw error;
            })
          : null;
        if (channel)
          assert(
            channel.type === ChannelType.GuildText &&
              app.store.get(i.guildId, 'honeypotChannel', channel.id),
            'The configured channel was not created by honeypot setup. Clear honeypot.channel and run setup again.',
          );
        if (!channel) {
          channel = await i.guild.channels.create({
            name: 'honeypot',
            type: ChannelType.GuildText,
            topic:
              'DO NOT POST. Messages trigger a timeout and deletion of your recent messages across this server.',
            permissionOverwrites: [
              {
                id: i.guildId,
                allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory],
                deny: [P.MentionEveryone, P.CreatePublicThreads, P.CreatePrivateThreads],
              },
              {
                id: app.client.user!.id,
                allow: [
                  P.ViewChannel,
                  P.SendMessages,
                  P.ReadMessageHistory,
                  P.EmbedLinks,
                  P.ManageMessages,
                  P.ManageChannels,
                ],
              },
            ],
            reason: 'Owner enabled honeypot spam protection',
          });
          app.store.put(i.guildId, 'honeypotChannel', channel.id, { message: '', armed: false });
          const latest = app.store.config(i.guildId);
          latest.honeypot.channel = channel.id;
          app.store.setConfig(i.guildId, latest, i.user.id);
        }
        assert(channel.type === ChannelType.GuildText, 'Choose a standard text channel.');
        await botPermission(
          i.guild,
          [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.ManageMessages],
          channel,
        );
        const spoiler = i.options.getBoolean('spoiler') ?? cfg.honeypot.spoiler;
        assert(
          !spoiler || !channel.nsfw,
          'Remove the age restriction from the honeypot channel before enabling its spoiler flag.',
        );
        await channel.edit({
          flags: spoiler
            ? channel.flags.bitfield | ChannelFlags.IsSpoilerChannel
            : channel.flags.bitfield & ~ChannelFlags.IsSpoilerChannel,
          topic:
            'DO NOT POST. Messages trigger a timeout and deletion of your recent messages across this server.',
          reason: 'Honeypot setup',
        });
        const saved = app.store.get<{ message: string }>(i.guildId, 'honeypotChannel', channel.id);
        const previous = saved?.message
          ? await channel.messages.fetch(saved.message).catch((error) => {
              if ((error as { code?: number }).code === 10008) return null;
              throw error;
            })
          : null;
        const content = { components: [honeypotWarning(true)], allowedMentions: noMentions };
        const post = previous
          ? await previous.edit(modernEdit(content))
          : await sendModern(channel, content);
        const latest = app.store.config(i.guildId);
        assert(
          latest.modules.automod && latest.modules.moderation && latest.modules.messages,
          'A required module was disabled during setup. Run setup again.',
        );
        latest.honeypot = {
          enabled: true,
          channel: channel.id,
          spoiler,
          cleanupMinutes: i.options.getInteger('cleanup_minutes') ?? latest.honeypot.cleanupMinutes,
          timeoutDays: i.options.getInteger('timeout_days') ?? latest.honeypot.timeoutDays,
        };
        app.store.setConfig(i.guildId, latest, i.user.id);
        // Arm last: a crash during setup must leave detection off until setup is retried.
        app.store.put(i.guildId, 'honeypotChannel', channel.id, { message: post.id, armed: true });
        await reply(
          i,
          `Honeypot enabled in <#${channel.id}> (#honeypot). Timeout: ${latest.honeypot.timeoutDays} days. Cleanup: ${latest.honeypot.cleanupMinutes} minutes. Spoiler: ${spoiler}.`,
        );
      });
    },
  },
  component: async (app, i) => {
    if (!i.isButton() || !i.customId.startsWith('honeypot:release:')) return false;
    await releaseHoneypot(app, i, i.customId.split(':')[2]!, i);
    return true;
  },
};
