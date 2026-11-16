import { randomInt } from 'node:crypto';
import { ChannelType, PermissionFlagsBits as P, type GuildTextBasedChannel } from 'discord.js';
import type { App } from './types.js';
import type { GuildConfig } from './config.js';
import { roastLines } from './roast-lines.js';
import { assert } from './util.js';
import { textChannel } from './discord.js';
import { botPermission } from './permissions.js';

export type RoastConfig = GuildConfig['roast'];
export interface RoastSubmission {
  actor: string;
  authorName: string;
  text: string;
  normalized: string;
  status: 'pending' | 'approved' | 'rejected' | 'disabled';
  channel: string;
  message: string;
  created: number;
  reviewedBy?: string;
  reviewedAt?: number;
  needsRender?: boolean;
}
export function roastAllowed(app: App, user: string) {
  return (
    app.store.get<{ allowed: boolean }>(app.guildId, 'roastPreference', user)?.allowed !== false
  );
}
export function normalizeRoast(text: string) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('{target}', '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function validateRoast(text: string) {
  const value = text.trim();
  assert(value.length > 0 && value.length <= 300, 'Use 1–300 characters.');
  assert(
    !/<[@#]|@(everyone|here)\b|https?:\/\/|discord\.gg\//i.test(value),
    'Use reusable text without user/role mentions or links. {target} is supported.',
  );
  assert(!/\{(?!target\})[^{}]*\}/.test(value), 'Only the {target} placeholder is supported.');
  assert(normalizeRoast(value).length > 0, 'Add some roast text.');
  return value;
}
export function roastSubmissions(app: App) {
  return app.store.entries<RoastSubmission>(app.guildId, 'roastSubmission', 2001);
}
export function roastChannelAllowed(app: App, channel: GuildTextBasedChannel) {
  const cfg = app.store.config(app.guildId);
  assert(cfg.modules.community && cfg.roast.enabled, 'Roasts are disabled.');
  const ids = [channel.id, channel.parentId].filter((id): id is string => !!id);
  assert(
    !ids.some(
      (id) =>
        cfg.excludedChannels.includes(id) ||
        Object.values(cfg.logs).includes(id) ||
        id === cfg.confessions.channel ||
        id === cfg.confessions.reviewChannel ||
        app.store.get(app.guildId, 'ticket', id),
    ),
    'Roasts are unavailable in this channel.',
  );
  assert(
    !cfg.roast.channels.length || cfg.roast.channels.some((id) => ids.includes(id)),
    'Use a configured roast channel.',
  );
  assert(
    !channel.isThread() || (!channel.archived && !channel.locked),
    'This thread is archived or locked.',
  );
}
export async function publicRoastBoard(app: App, id: string) {
  const channel = await textChannel(app, app.guildId, id);
  assert(
    channel.type === ChannelType.GuildText &&
      channel
        .permissionsFor(channel.guild.roles.everyone)
        ?.has([P.ViewChannel, P.ReadMessageHistory]),
    'Choose a public text channel for roast submissions; your suggestions channel is fine.',
  );
  await botPermission(channel.guild, [P.SendMessages, P.ReadMessageHistory], channel);
  return channel;
}
export function roastPool(app: App) {
  const custom = roastSubmissions(app).filter((entry) => entry.data.status === 'approved');
  return [
    ...roastLines.map((text, index) => ({ key: `builtin-${index}`, text })),
    ...custom.map((entry) => ({ key: entry.key, text: entry.data.text })),
  ];
}
export function chooseRoast(app: App, channel: string, bot = false) {
  const pool = bot
    ? [
        {
          key: 'bot-0',
          text: 'my confidence is 100%; my uptime depends on someone remembering the hosting panel.',
        },
        {
          key: 'bot-1',
          text: 'I have a command for everything except fixing my own sense of humour.',
        },
        { key: 'bot-2', text: 'I live in a container and still think I am going places.' },
      ]
    : roastPool(app);
  const recent = app.store.get<string[]>(app.guildId, 'roastRecent', channel) ?? [];
  const fresh = pool.filter((entry) => !recent.includes(entry.key));
  const options = fresh.length ? fresh : pool.filter((entry) => entry.key !== recent.at(-1));
  const choices = options.length ? options : pool;
  const selected = choices[randomInt(choices.length)]!;
  app.store.put(app.guildId, 'roastRecent', channel, [...recent, selected.key].slice(-10));
  return selected.text;
}
