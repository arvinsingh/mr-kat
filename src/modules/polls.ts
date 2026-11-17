import { modernEdit, sendModern } from '../presentation.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits as P } from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Module } from '../types.js';
import { enabled, requirePermission, botPermission } from '../permissions.js';
import { assert, duration, safe } from '../util.js';
import { reply, embed, noMentions } from '../ui.js';
import { destination, textChannel } from '../discord.js';
import { coalesced } from '../concurrency.js';
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
export function pollResults(poll: Poll): string {
  const counts = poll.choices.map(() => 0);
  for (const vote of Object.values(poll.votes)) if (counts[vote] !== undefined) counts[vote]++;
  return `${safe(poll.question, 800)}\n\n${poll.choices.map((choice, index) => `${index + 1}. ${safe(choice, 150)} — **${counts[index]}**`).join('\n')}\n\n${poll.closed || poll.expires <= Date.now() ? 'Closed' : `Closes <t:${Math.floor(poll.expires / 1000)}:R>`}\n${poll.anonymous ? 'Voter names are hidden from members. IDs are stored internally to enforce one vote per member.' : 'Votes are recorded by member ID.'}`;
}
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
export function updatePoll(app: App, guild: string, key: string) {
  return coalesced(app, `poll:${guild}:${key}`, () => renderPoll(app, guild, key));
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
export const polls: Module = {
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
        assert(app.store.activePolls(i.guildId) < 25, 'There are already 25 active polls.');
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
        const message = await sendModern(channel, {
          embeds: [embed(`Poll ${key}`, pollResults(poll), 'poll')],
          components: pollControls(key, poll),
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
