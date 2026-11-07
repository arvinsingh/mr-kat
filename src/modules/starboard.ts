import {
  ChannelType,
  ReactionType,
  PermissionFlagsBits as P,
  type Message,
  type PartialMessage,
  type GuildTextBasedChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Module } from '../types.js';
import type { GuildConfig } from '../config.js';
import { owner, requirePermission, botPermission, enabled } from '../permissions.js';
import { textChannel } from '../discord.js';
import { embed, linkButtons, noMentions, reply } from '../ui.js';
import { assert, safe, UserError } from '../util.js';
import { messageLogExcludedChannel } from '../message-logs.js';

export interface StarboardEntry {
  sourceChannel: string;
  sourceParent?: string;
  sourceCategory?: string;
  boardChannel: string;
  boardMessage?: string;
  count: number;
  state: 'publishing' | 'published' | 'uncertain';
}
const pending = new Map<string, Promise<void>>();
async function serial(key: string, work: () => Promise<void>) {
  const previous = pending.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  pending.set(key, next);
  try {
    await next;
  } finally {
    if (pending.get(key) === next) pending.delete(key);
  }
}
export function starboardSourceAllowed(
  message: Message,
  board: GuildTextBasedChannel,
  cfg: GuildConfig,
) {
  const source = message.channel;
  if (
    !message.guild ||
    message.author.bot ||
    message.webhookId ||
    source.id === board.id ||
    source.id === cfg.confessions.channel ||
    messageLogExcludedChannel(cfg, source.id)
  )
    return false;
  if (source.isDMBased()) return false;
  const parent = source.isThread() ? source.parent : source;
  if (
    !parent ||
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(parent.type) ||
    source.type === ChannelType.PrivateThread ||
    messageLogExcludedChannel(cfg, parent.id) ||
    parent.id === cfg.confessions.channel ||
    parent.id === board.id
  )
    return false;
  // Only public sources: never widen the audience of a private message.
  if (
    !parent
      .permissionsFor(message.guild.roles.everyone)
      ?.has([P.ViewChannel, P.ReadMessageHistory]) ||
    !source.permissionsFor(message.guild.roles.everyone)?.has([P.ViewChannel, P.ReadMessageHistory])
  )
    return false;
  if (parent.nsfw && !('nsfw' in board && board.nsfw)) return false;
  return true;
}
async function starCount(message: Message, selfStars: boolean) {
  const users = new Set<string>();
  for (const reaction of message.reactions.cache.values()) {
    if (reaction.emoji.id || reaction.emoji.name?.replace(/\uFE0F/g, '') !== '⭐') continue;
    for (const type of [
      ReactionType.Normal,
      ...(reaction.countDetails?.burst ? [ReactionType.Burst] : []),
    ]) {
      let after: string | undefined;
      for (;;) {
        const page = await reaction.users.fetch({ limit: 100, type, ...(after ? { after } : {}) });
        for (const user of page.values())
          if (!user.bot && (selfStars || user.id !== message.author.id)) users.add(user.id);
        if (page.size < 100) break;
        const last = page.lastKey();
        if (!last || last === after) break;
        after = last;
      }
    }
  }
  return users.size;
}
async function removeEntry(app: App, id: string, entry: StarboardEntry) {
  if (entry.boardMessage) {
    const board = await textChannel(app, app.guildId, entry.boardChannel).catch(
      (error: unknown) => {
        if ((error as { code?: number }).code === 10003) return null;
        throw error;
      },
    );
    if (board) {
      try {
        const post = await board.messages.fetch(entry.boardMessage);
        assert(post.author.id === app.client.user!.id, 'Starboard post ownership changed.');
        await post.delete();
      } catch (error) {
        if ((error as { code?: number }).code !== 10008) throw error;
      }
    }
  } else {
    // An ambiguous send might already have created a post. Preserve its receipt.
    return;
  }
  app.store.delete(app.guildId, 'starboardEntry', id);
}
export async function removeStarboardMessage(
  app: App,
  message: Pick<Message | PartialMessage, 'id' | 'guildId'>,
) {
  if (message.guildId !== app.guildId) return;
  await serial(`${app.guildId}:${message.id}`, async () => {
    const entry = app.store.get<StarboardEntry>(app.guildId, 'starboardEntry', message.id);
    if (entry) await removeEntry(app, message.id, entry);
  });
}
export async function starboardChannelChanged(app: App, channel: string, deleted = false) {
  for (const item of app.store.entries<StarboardEntry>(app.guildId, 'starboardEntry', 10000)) {
    if (
      ![
        item.data.sourceChannel,
        item.data.sourceParent,
        item.data.sourceCategory,
        item.data.boardChannel,
      ].includes(channel)
    )
      continue;
    if (deleted && item.data.boardChannel === channel) {
      await serial(`${app.guildId}:${item.key}`, async () => {
        app.store.delete(app.guildId, 'starboardEntry', item.key);
      });
    } else if (deleted && [item.data.sourceChannel, item.data.sourceParent].includes(channel)) {
      await removeStarboardMessage(app, { id: item.key, guildId: app.guildId });
    } else
      await syncStarboard(app, {
        id: item.key,
        guildId: app.guildId,
        channelId: item.data.sourceChannel,
      });
  }
}
export async function syncStarboard(
  app: App,
  source: Pick<Message | PartialMessage, 'id' | 'guildId' | 'channelId'>,
  recover = false,
) {
  if (source.guildId !== app.guildId) return;
  const initial = app.store.config(app.guildId);
  if (!initial.modules.community || !initial.starboard.enabled || !initial.starboard.channel)
    return;
  await serial(`${app.guildId}:${source.id}`, async () => {
    const cfg = app.store.config(app.guildId);
    if (!cfg.modules.community || !cfg.starboard.enabled || !cfg.starboard.channel) return;
    let entry = app.store.get<StarboardEntry>(app.guildId, 'starboardEntry', source.id);
    const board = await textChannel(app, app.guildId, entry?.boardChannel ?? cfg.starboard.channel);
    if (entry && !entry.boardMessage && recover) {
      const recent = await board.messages.fetch({ limit: 100 });
      const found = recent.find(
        (m) =>
          m.author.id === app.client.user!.id &&
          m.embeds.some((e) => e.footer?.text === `Starboard · ${source.id}`),
      );
      if (found) {
        entry.boardMessage = found.id;
        entry.state = 'published';
        app.store.put(app.guildId, 'starboardEntry', source.id, entry);
      }
    }
    assert(
      !entry || entry.boardMessage,
      'Delivery is uncertain. Refresh checks the last 100 starboard posts; contact the owner if the original copy cannot be found. No duplicate is posted.',
    );
    let message: Message;
    try {
      const channel = await textChannel(app, app.guildId, source.channelId);
      message = await channel.messages.fetch({ message: source.id, force: true });
    } catch (error) {
      if (
        [10008, 10003, 50001, 50013].includes((error as { code?: number }).code ?? 0) ||
        error instanceof UserError
      ) {
        if (entry) await removeEntry(app, source.id, entry);
        return;
      }
      throw error;
    }
    if (!starboardSourceAllowed(message, board, cfg)) {
      if (entry) await removeEntry(app, source.id, entry);
      return;
    }
    const count = await starCount(message, cfg.starboard.selfStars);
    if (count < cfg.starboard.threshold) {
      if (entry) await removeEntry(app, source.id, entry);
      return;
    }
    await botPermission(board.guild, [P.SendMessages, P.EmbedLinks, P.ReadMessageHistory], board);
    const card = embed(
      `⭐ ${count} · #${safe(message.channel.isThread() ? (message.channel.parent?.name ?? 'thread') : 'name' in message.channel ? message.channel.name : 'channel', 80)}`,
      message.content ? safe(message.content, 3000) : '*Message has no text.*',
      'starboard',
    )
      .setAuthor({
        name: (message.member?.displayName ?? message.author.username).slice(0, 256),
        iconURL: message.author.displayAvatarURL(),
      })
      .setFooter({ text: `Starboard · ${source.id}` })
      .setTimestamp(message.createdAt);
    const attachments = [...message.attachments.values()].filter(
      (a) => !a.spoiler && a.url.startsWith('https://'),
    );
    const image = attachments.find((a) => a.contentType?.startsWith('image/'));
    if (image) card.setImage(image.url);
    if (attachments.length)
      card.addFields({
        name: 'Attachments',
        value: attachments
          .slice(0, 5)
          .map((a, n) => `[Attachment ${n + 1}](${a.url})`)
          .join(' · ')
          .slice(0, 1024),
      });
    const options = {
      embeds: [card],
      components: linkButtons([{ label: 'View original', url: message.url }]),
      allowedMentions: noMentions,
    };
    if (entry?.boardMessage) {
      try {
        const post = await board.messages.fetch(entry.boardMessage);
        assert(post.author.id === app.client.user!.id, 'Starboard post ownership changed.');
        await post.edit(options);
        entry.count = count;
        app.store.put(app.guildId, 'starboardEntry', source.id, entry);
        return;
      } catch (error) {
        if ((error as { code?: number }).code !== 10008) throw error;
      }
    }
    // Persist before sending so a timeout/restart never blindly duplicates a post.
    entry = {
      sourceChannel: source.channelId,
      sourceParent: message.channel.isThread()
        ? (message.channel.parentId ?? undefined)
        : undefined,
      sourceCategory: message.channel.isThread()
        ? (message.channel.parent?.parentId ?? undefined)
        : 'parentId' in message.channel
          ? (message.channel.parentId ?? undefined)
          : undefined,
      boardChannel: board.id,
      count,
      state: 'publishing',
    };
    app.store.put(app.guildId, 'starboardEntry', source.id, entry);
    try {
      const post = await board.send({
        ...options,
        nonce: randomUUID().replaceAll('-', '').slice(0, 24),
        enforceNonce: true,
      });
      entry.boardMessage = post.id;
      entry.state = 'published';
    } catch (error) {
      entry.state = 'uncertain';
      throw error;
    } finally {
      app.store.put(app.guildId, 'starboardEntry', source.id, entry);
    }
  });
}
export const starboard: Module = {
  commands: {
    starboard: async (app, i) => {
      const action = i.options.getSubcommand();
      const cfg = app.store.config(i.guildId);
      if (action === 'setup' || action === 'disable') owner(i);
      else await requirePermission(app, i, P.ManageMessages);
      if (action === 'status') {
        const unresolved = app.store
          .entries<StarboardEntry>(i.guildId, 'starboardEntry', 10000)
          .filter((e) => !e.data.boardMessage).length;
        await reply(
          i,
          `Starboard: ${cfg.starboard.enabled ? 'on' : 'off'}\nCommunity module: ${cfg.modules.community ? 'on' : 'off'}\nChannel: ${cfg.starboard.channel ? `<#${cfg.starboard.channel}>` : 'not set'}\n⭐ threshold: ${cfg.starboard.threshold} unique people\nAuthor’s own star counts: ${cfg.starboard.selfStars}\nUnresolved deliveries: ${unresolved}\nOnly public channels/public threads are eligible. Bots, webhooks, private channels, log/excluded channels and confession channels are skipped. NSFW messages require an NSFW board. Existing posts keep their original destination when setup changes.`,
        );
      } else if (action === 'disable') {
        cfg.starboard.enabled = false;
        app.store.setConfig(i.guildId, cfg, i.user.id);
        await reply(
          i,
          'Starboard disabled. Existing copies remain; source-deletion cleanup still runs.',
        );
      } else if (action === 'setup') {
        const channel = await textChannel(app, i.guildId, i.options.getChannel('channel', true).id);
        assert(
          channel.type === ChannelType.GuildText,
          'Choose a normal text channel for the starboard.',
        );
        await botPermission(i.guild, [P.SendMessages, P.EmbedLinks, P.ReadMessageHistory], channel);
        assert(
          !messageLogExcludedChannel(cfg, channel.id) && channel.id !== cfg.confessions.channel,
          'Choose a separate channel, outside logs, exclusions and confessions.',
        );
        cfg.starboard = {
          enabled: true,
          channel: channel.id,
          threshold: i.options.getInteger('threshold') ?? cfg.starboard.threshold,
          selfStars: i.options.getBoolean('self_stars') ?? cfg.starboard.selfStars,
        };
        app.store.setConfig(i.guildId, cfg, i.user.id);
        await reply(
          i,
          `Starboard enabled in <#${channel.id}> at ${cfg.starboard.threshold} ⭐. New reaction events are watched; use /starboard refresh for an older message. Public sources only. Enable the community module if it is off.`,
        );
      } else {
        assert(action === 'refresh', 'Unknown starboard action.');
        enabled(app, i.guildId, 'community');
        assert(
          cfg.starboard.enabled && cfg.starboard.channel,
          'Set up and enable starboard first.',
        );
        const channel = await textChannel(app, i.guildId, i.options.getChannel('channel', true).id);
        await requirePermission(
          app,
          i,
          [P.ViewChannel, P.ReadMessageHistory, P.ManageMessages],
          channel,
        );
        const id = i.options.getString('message', true);
        assert(/^\d{17,22}$/.test(id), 'Provide the original message ID.');
        await syncStarboard(app, { id, channelId: channel.id, guildId: i.guildId }, true);
        await reply(
          i,
          'Starboard refreshed. A copy appears only when the source is eligible and meets the threshold.',
        );
      }
    },
  },
};
