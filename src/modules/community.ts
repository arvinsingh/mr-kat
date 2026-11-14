import { suggestions } from './suggestions.js';
import { modernEdit, sendModern } from '../presentation.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits as P } from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Module } from '../types.js';
import { enabled, requirePermission, botPermission } from '../permissions.js';
import { assert, duration, safe } from '../util.js';
import { reply, embed, noMentions } from '../ui.js';
import { destination, send, textChannel } from '../discord.js';
export interface Poll {
  question: string;
  choices: string[];
  votes: Record<string, number>;
  actor: string;
  channel: string;
  message: string;
  expires: number;
  closed: boolean;
  anonymous: boolean;
}
export type { Suggestion } from './suggestions.js';
export function pollResults(poll: Poll): string {
  const counts = poll.choices.map(
    (_, index) => Object.values(poll.votes).filter((value) => value === index).length,
  );
  return `${safe(poll.question, 800)}\n\n${poll.choices.map((choice, index) => `${index + 1}. ${safe(choice, 150)} — **${counts[index]}**`).join('\n')}\n\n${poll.closed || poll.expires <= Date.now() ? 'Closed' : `Closes <t:${Math.floor(poll.expires / 1000)}:R>`}\n${poll.anonymous ? 'Voter names are hidden from members. IDs are stored internally to enforce one vote per member.' : 'Votes are recorded by member ID.'}`;
}
const pollRefresh = new Map<string, Promise<void>>();
function pollControls(key: string, poll: Poll) {
  return poll.closed || poll.expires <= Date.now()
    ? []
    : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          poll.choices.map((choice, index) =>
            new ButtonBuilder()
              .setCustomId(`vote:${key}:${index}`)
              .setLabel(`${index + 1}. ${choice}`.slice(0, 80))
              .setStyle(ButtonStyle.Primary),
          ),
        ),
      ];
}
export async function updatePoll(app: App, guild: string, key: string) {
  const identity = `${guild}:${key}`;
  const previous = pollRefresh.get(identity) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => renderPoll(app, guild, key));
  pollRefresh.set(identity, next);
  try {
    await next;
  } finally {
    if (pollRefresh.get(identity) === next) pollRefresh.delete(identity);
  }
}
async function renderPoll(app: App, guild: string, key: string) {
  const poll = app.store.get<Poll>(guild, 'poll', key);
  if (!poll) return;
  const channel = await app.client.channels.fetch(poll.channel);
  if (!channel?.isTextBased() || !channel.isSendable()) return;
  const message = await channel.messages.fetch(poll.message);
  await message.edit(
    modernEdit({
      embeds: [embed(`Poll ${key}`, pollResults(poll), 'poll')],
      components: pollControls(key, poll),
      allowedMentions: noMentions,
    }),
  );
}
export const community: Module = {
  commands: {
    poll: async (app, i) => {
      enabled(app, i.guildId, 'community');
      const action = i.options.getSubcommand();
      if (action === 'create') {
        const channel = await destination(app, i, i.channelId);
        await botPermission(i.guild, P.EmbedLinks, channel);
        const choices = i.options
          .getString('choices', true)
          .split('|')
          .map((s) => s.trim());
        assert(
          choices.length >= 2 &&
            choices.length <= 5 &&
            choices.every((s) => s.length > 0 && s.length <= 100),
          'Supply 2–5 choices, each 1–100 characters, separated by |.',
        );
        assert(
          app.store
            .entries<Poll>(i.guildId, 'poll')
            .filter((e) => !e.data.closed && e.data.expires > Date.now()).length < 25,
          'There are already 25 active polls.',
        );
        const key = randomUUID().slice(0, 8);
        const poll: Poll = {
          question: i.options.getString('question', true),
          choices,
          votes: {},
          actor: i.user.id,
          channel: channel.id,
          message: '',
          expires: Date.now() + duration(i.options.getString('duration', true)),
          closed: false,
          anonymous: i.options.getBoolean('anonymous') ?? true,
        };
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          choices.map((choice, index) =>
            new ButtonBuilder()
              .setCustomId(`vote:${key}:${index}`)
              .setLabel(`${index + 1}. ${choice}`.slice(0, 80))
              .setStyle(ButtonStyle.Primary),
          ),
        );
        const message = await sendModern(channel, {
          embeds: [embed(`Poll ${key}`, pollResults(poll), 'poll')],
          components: [row],
          allowedMentions: noMentions,
        });
        poll.message = message.id;
        app.store.put(i.guildId, 'poll', key, poll);
        app.store.job(i.guildId, i.user.id, 'pollClose', { key }, poll.expires);
        await reply(i, `Poll published. ID: ${key}.`);
        return;
      }
      const key = i.options.getString('id', true),
        poll = app.store.get<Poll>(i.guildId, 'poll', key);
      assert(poll, 'Poll not found.');
      const channel = await textChannel(app, i.guildId, poll.channel);
      const member = await i.guild.members.fetch(i.user.id);
      assert(
        channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]),
        'You cannot view this poll in its original channel.',
      );
      if (action === 'close') {
        if (poll.actor !== i.user.id) await requirePermission(app, i, P.ManageMessages, channel);
        poll.closed = true;
        app.store.put(i.guildId, 'poll', key, poll);
        await updatePoll(app, i.guildId, key);
      }
      await reply(i, { embeds: [embed(`Poll ${key}`, pollResults(poll), 'poll')] });
    },
    suggest: suggestions.commands!.suggest!,
    remind: async (app, i) => {
      enabled(app, i.guildId, 'community');
      assert(
        app.store
          .jobs(i.guildId, 1000)
          .filter(
            (j) =>
              j.actor === i.user.id &&
              j.kind === 'reminder' &&
              ['ready', 'running'].includes(j.state),
          ).length < 20,
        'You already have 20 pending reminders.',
      );
      const delay = duration(i.options.getString('in', true));
      const key = app.store.job(
        i.guildId,
        i.user.id,
        'reminder',
        { text: i.options.getString('text', true), user: i.user.id, server: i.guild.name },
        Date.now() + delay,
      );
      await reply(
        i,
        `Reminder scheduled <t:${Math.floor((Date.now() + delay) / 1000)}:R>. Delivery is by DM; enable DMs for this server. Job: ${key}.`,
      );
    },
    event: async (app, i) => {
      enabled(app, i.guildId, 'community');
      await requirePermission(app, i, P.ManageMessages);
      const channel = await destination(app, i, i.options.getChannel('channel', true).id);
      const delay = duration(i.options.getString('in', true));
      const key = app.store.job(
        i.guildId,
        i.user.id,
        'announce',
        { channel: channel.id, title: 'Event reminder', text: i.options.getString('text', true) },
        Date.now() + delay,
      );
      await reply(i, `Event reminder scheduled. Job: ${key}.`);
    },
    stats: async (app, i) => {
      enabled(app, i.guildId, 'stats');
      await requirePermission(app, i, P.ModerateMembers);
      const stats = app.store.stats(i.guildId);
      await reply(i, {
        embeds: [
          embed(
            'Server statistics · last 30 days',
            `Members now: ${i.guild.memberCount}\nJoins: ${stats.joins ?? 0}\nLeaves: ${stats.leaves ?? 0}\nMessages observed: ${stats.messages ?? 0}\nConnected voice hours: ${((stats.voiceSeconds ?? 0) / 3600).toFixed(1)}\nModeration actions: ${stats.moderation ?? 0}\n\nCounts start when this bot is connected. Excluded channels are omitted; voice time does not measure speaking.`,
          ),
        ],
      });
    },
    activity: async (app, i) => {
      enabled(app, i.guildId, 'stats');
      await requirePermission(app, i, P.ModerateMembers);
      const days = i.options.getInteger('days') ?? 30;
      const cutoff = Date.now() - days * 86400000;
      const entries = app.store
        .entries<{ last: number }>(i.guildId, 'activity', 1000)
        .filter((e) => e.data.last < cutoff)
        .slice(0, 30);
      await reply(
        i,
        `Members with previously observed activity older than ${days} days:\n${entries.map((e) => `<@${e.key}> · <t:${Math.floor(e.data.last / 1000)}:R>`).join('\n') || 'None in the retained observations.'}\nThis is not proof of inactivity; unobserved members are omitted.`,
      );
    },
  },
  component: async (app, i) => {
    if (!i.isButton() || !i.customId.startsWith('vote:')) return false;
    enabled(app, i.guildId, 'community');
    const [, key, indexText] = i.customId.split(':');
    const index = Number(indexText);
    app.store.transaction(() => {
      const poll = app.store.get<Poll>(i.guildId, 'poll', key!);
      assert(poll && !poll.closed && poll.expires > Date.now(), 'Voting is closed.');
      assert(poll.message === i.message.id && poll.channel === i.channelId, 'Invalid poll panel.');
      assert(
        Number.isInteger(index) && index >= 0 && index < poll.choices.length,
        'Invalid choice.',
      );
      poll.votes[i.user.id] = index;
      app.store.put(i.guildId, 'poll', key!, poll);
    });
    // Results are read from the latest stored vote totals; failure to refresh a message does not lose votes.
    await updatePoll(app, i.guildId, key!);
    await reply(i, 'Your vote was recorded. You can change it before the poll closes.');
    return true;
  },
};
