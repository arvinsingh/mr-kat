import { auditChange } from '../change-receipts.js';
import {
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits as P,
  type GuildChannel,
} from 'discord.js';
import type { App, Module, Interaction, Component } from '../types.js';
import { assert, duration, parseIds } from '../util.js';
import { requirePermission, botPermission, enabled } from '../permissions.js';
import { confirm, reply, type Confirmation } from '../ui.js';
import { channelNotice } from '../notices.js';
import { channelLabel } from '../channel-label.js';
const lockMask =
  P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;
interface SavedOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
  existed: boolean;
}
export interface ChannelLock {
  overwrites: SavedOverwrite[];
  actor: string;
  created: number;
}
export async function lockChannel(app: App, i: Interaction, channel: GuildChannel, kind = 'lock') {
  assert(
    'permissionOverwrites' in channel && channel.isTextBased() && !channel.isThread(),
    'Choose a standard text channel.',
  );
  await requirePermission(app, i, P.ManageChannels, channel);
  await botPermission(channel.guild, [P.ManageChannels, P.ManageRoles], channel);
  assert(
    !app.store.get(i.guildId!, kind, channel.id),
    'This channel is already locked/archived by the bot.',
  );
  assert(
    !app.store.get(i.guildId!, kind === 'lock' ? 'archive' : 'lock', channel.id),
    'Restore the existing archive/lock before applying another.',
  );
  const relevant = channel.permissionOverwrites.cache.filter(
    (o) =>
      o.id === app.client.user!.id ||
      o.id === channel.guild.id ||
      (o.allow.bitfield & lockMask) !== 0n,
  );
  const saved: SavedOverwrite[] = relevant.map((o) => ({
    id: o.id,
    type: o.type as 0 | 1,
    allow: String(o.allow.bitfield & lockMask),
    deny: String(o.deny.bitfield & lockMask),
    existed: true,
  }));
  if (!saved.some((o) => o.id === channel.guild.id))
    saved.push({ id: channel.guild.id, type: 0, allow: '0', deny: '0', existed: false });
  if (!saved.some((o) => o.id === app.client.user!.id))
    saved.push({ id: app.client.user!.id, type: 1, allow: '0', deny: '0', existed: false });
  const record: ChannelLock = {
    overwrites: saved,
    actor: i.user.id,
    created: Date.now(),
  };
  app.store.put(i.guildId!, kind, channel.id, record);
  try {
    for (const o of saved)
      await channel.permissionOverwrites.edit(
        o.id,
        {
          SendMessages: o.id === app.client.user!.id,
          SendMessagesInThreads: o.id === app.client.user!.id,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
        },
        { type: o.type, reason: `Bot ${kind} by ${i.user.id}` },
      );
  } catch (error) {
    await restoreLock(app, channel, kind).catch(() => undefined);
    throw error;
  }
}
export async function restoreLock(app: App, channel: GuildChannel, kind = 'lock') {
  assert('permissionOverwrites' in channel, 'Unsupported channel.');
  const saved = app.store.get<ChannelLock>(channel.guild.id, kind, channel.id);
  assert(saved, 'No saved permissions to restore.');
  for (const o of saved.overwrites) {
    if (o.type === 0 && !channel.guild.roles.cache.has(o.id)) continue;
    const current = channel.permissionOverwrites.cache.get(o.id);
    const allow = ((current?.allow.bitfield ?? 0n) & ~lockMask) | BigInt(o.allow);
    const deny = ((current?.deny.bitfield ?? 0n) & ~lockMask) | BigInt(o.deny);
    if (!o.existed && allow === 0n && deny === 0n) {
      if (current) await current.delete('Restore pre-lock permissions');
    } else
      await channel.permissionOverwrites.edit(
        o.id,
        {
          SendMessages: allow & P.SendMessages ? true : deny & P.SendMessages ? false : null,
          SendMessagesInThreads:
            allow & P.SendMessagesInThreads ? true : deny & P.SendMessagesInThreads ? false : null,
          CreatePublicThreads:
            allow & P.CreatePublicThreads ? true : deny & P.CreatePublicThreads ? false : null,
          CreatePrivateThreads:
            allow & P.CreatePrivateThreads ? true : deny & P.CreatePrivateThreads ? false : null,
        },
        { type: o.type, reason: 'Restore pre-lock permissions' },
      );
  }
  app.store.delete(channel.guild.id, kind, channel.id);
}
export const channels: Module = {
  commands: {
    channel: async (app, i) => {
      enabled(app, i.guildId, 'channels');
      await requirePermission(app, i, P.ManageChannels);
      const action = i.options.getSubcommand();
      const channel = i.channel;
      if (action === 'snapshot') {
        await i.guild.channels.fetch();
        await i.guild.roles.fetch();
        const snapshot = {
          created: new Date().toISOString(),
          roles: i.guild.roles.cache.map((r) => ({
            id: r.id,
            name: r.name,
            permissions: r.permissions.bitfield.toString(),
            position: r.position,
            color: r.color,
            managed: r.managed,
          })),
          channels: i.guild.channels.cache.map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            parent: c.parentId,
            ...('permissionOverwrites' in c
              ? {
                  overwrites: c.permissionOverwrites.cache.map((o) => ({
                    id: o.id,
                    type: o.type,
                    allow: o.allow.bitfield.toString(),
                    deny: o.deny.bitfield.toString(),
                  })),
                }
              : {}),
          })),
        };
        await reply(i, {
          content: 'Reference snapshot only: this cannot recover deleted messages or original IDs.',
          files: [
            new AttachmentBuilder(Buffer.from(JSON.stringify(snapshot, null, 2)), {
              name: 'server-structure.json',
            }),
          ],
        });
        return;
      }
      assert(channel && !channel.isDMBased(), 'Use a server channel.');
      if (action === 'inspect') {
        const member = await i.guild.members.fetch(i.options.getUser('member')?.id ?? i.user.id);
        await reply(
          i,
          `Effective permissions for <@${member.id}>:\n${channel.permissionsFor(member)?.toArray().join(', ') || 'None'}`,
        );
        return;
      }
      await requirePermission(app, i, P.ManageChannels, channel);
      await botPermission(i.guild, P.ManageChannels, channel);
      if (action === 'temporary') {
        const lifetime = duration(i.options.getString('duration', true));
        const created = await i.guild.channels.create({
          name: i.options.getString('name', true).slice(0, 90),
          type: ChannelType.GuildText,
          parent: channel.parentId,
          reason: `Temporary room by ${i.user.id}`,
          permissionOverwrites: [
            { id: i.guildId, deny: [P.ViewChannel] },
            { id: i.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
            { id: app.client.user!.id, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels] },
            ...app.store.config(i.guildId).staffRoles.map((id) => ({
              id,
              allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory],
            })),
          ],
        });
        app.store.put(i.guildId, 'tempText', created.id, {
          owner: i.user.id,
          name: created.name,
          expires: Date.now() + lifetime,
        });
        app.store.job(
          i.guildId,
          i.user.id,
          'deleteChannel',
          { channel: created.id, name: created.name },
          Date.now() + lifetime,
        );
        await reply(
          i,
          `Created ${channelLabel(created.id, created.name)}. It expires <t:${Math.floor((Date.now() + lifetime) / 1000)}:R>.`,
        );
        return;
      }
      assert(!channel.isThread(), 'Use a standard text channel.');
      if (action === 'slowmode') {
        assert('setRateLimitPerUser' in channel, 'This channel does not support slowmode.');
        await channel.setRateLimitPerUser(i.options.getInteger('seconds', true), `By ${i.user.id}`);
      } else if (action === 'lock' || action === 'archive')
        await lockChannel(app, i, channel, action);
      else await restoreLock(app, channel, action === 'unarchive' ? 'archive' : 'lock');
      await auditChange(app, i, `Channel ${action}`, 'Channel permissions updated.', {
        reference: `<#${channel.id}>`,
      });
      const announced = await channelNotice(
        app,
        i.guildId,
        channel.id,
        'admin',
        `Channel ${action}`,
        `Channel ${action} completed at <t:${Math.floor(Date.now() / 1000)}:F>. Administrators retain access under Discord permissions.`,
      );
      await reply(
        i,
        `Channel ${action} completed.${announced ? '' : ' The channel notice could not be confirmed; check the admin log.'}`,
      );
    },
    panic: async (app, i) => {
      enabled(app, i.guildId, 'channels');
      await requirePermission(app, i, P.ManageGuild);
      if (i.options.getSubcommand() === 'on') {
        const ids = parseIds(i.options.getString('channels', true));
        for (const key of ids) {
          const ch = await i.guild.channels.fetch(key);
          assert(
            ch && ch.type === ChannelType.GuildText,
            'Panic mode accepts standard text channels only.',
          );
          await requirePermission(app, i, P.ManageChannels, ch);
        }
        await confirm(
          app,
          i,
          `Lock ${ids.length} selected channels and pause verification?`,
          'panicOn',
          { channels: ids },
        );
      } else {
        assert(app.store.get(i.guildId, 'panic', 'active'), 'Panic mode is not active.');
        await confirm(
          app,
          i,
          'Restore channel permissions changed by panic mode and restore the prior verification setting?',
          'panicOff',
          {},
        );
      }
    },
  },
};

export async function panicConfirmation(app: App, i: Component, pending: Confirmation) {
  if (pending.kind === 'panicOn') {
    enabled(app, i.guildId, 'channels');
    await requirePermission(app, i, P.ManageGuild);
    assert(!app.store.get(i.guildId, 'panic', 'active'), 'Panic mode is already active.');
    const cfg = app.store.config(i.guildId);
    const state = { channels: [] as string[], verificationPaused: cfg.verificationPaused };
    app.store.put(i.guildId, 'panic', 'active', state);
    cfg.verificationPaused = true;
    app.store.setConfig(i.guildId, cfg, i.user.id);
    for (const key of pending.payload.channels as string[]) {
      const channel = await i.guild.channels.fetch(key);
      assert(channel && !channel.isThread(), 'Channel no longer available.');
      assert(
        !app.store.get(i.guildId, 'lock', key) && !app.store.get(i.guildId, 'archive', key),
        'A selected channel already has a lock/archive; restore it first.',
      );
      state.channels.push(key);
      app.store.put(i.guildId, 'panic', 'active', state);
      await lockChannel(app, i, channel);
      await channelNotice(
        app,
        i.guildId,
        channel.id,
        'moderation',
        'Panic mode is in effect',
        `Activated at <t:${Math.floor(Date.now() / 1000)}:F>.\nIncident restrictions are active in this channel and verification is paused. Staff will post an update when panic mode ends.`,
      );
    }
    await auditChange(app, i, 'Panic mode enabled', `${state.channels.length} channels locked.`);
    await reply(i, 'Panic mode enabled. Use /panic off to restore changes.');
    return;
  }
  assert(pending.kind === 'panicOff', 'Unknown panic action.');
  enabled(app, i.guildId, 'channels');
  await requirePermission(app, i, P.ManageGuild);
  const state = app.store.get<{ channels: string[]; verificationPaused: boolean }>(
    i.guildId,
    'panic',
    'active',
  );
  assert(state, 'Panic mode is not active.');
  for (const key of [...state.channels]) {
    const channel = await i.guild.channels.fetch(key);
    if (channel && !channel.isThread()) {
      await requirePermission(app, i, P.ManageChannels, channel);
      if (app.store.get(i.guildId, 'lock', key)) await restoreLock(app, channel);
      await channelNotice(
        app,
        i.guildId,
        channel.id,
        'admin',
        'Panic mode ended',
        `Restored at <t:${Math.floor(Date.now() / 1000)}:F>.\nThis channel's pre-panic permissions have been restored. Other server restrictions may still apply.`,
      );
    }
    state.channels = state.channels.filter((c) => c !== key);
    app.store.put(i.guildId, 'panic', 'active', state);
  }
  const cfg = app.store.config(i.guildId);
  cfg.verificationPaused = state.verificationPaused;
  app.store.setConfig(i.guildId, cfg, i.user.id);
  app.store.delete(i.guildId, 'panic', 'active');
  await reply(i, 'Panic changes restored.');
  return;
}
