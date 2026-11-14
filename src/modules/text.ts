import { sendModern, displayText } from '../presentation.js';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits as P,
  StringSelectMenuBuilder,
  type GuildTextBasedChannel,
  type Message,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import type { App, Module } from '../types.js';
import { textChannel } from '../discord.js';
import { assert, logError, UserError } from '../util.js';
import { noMentions, reply } from '../ui.js';
import { textEffects, transformText, type TextEffect, type TextOptions } from '../text-effects.js';

function available(app: App, channel: GuildTextBasedChannel) {
  const cfg = app.store.config(channel.guildId);
  assert(cfg.modules.community && cfg.textEffects.enabled, 'Text effects are disabled.');
  assert(
    !cfg.excludedChannels.includes(channel.id) &&
      !(channel.parentId && cfg.excludedChannels.includes(channel.parentId)),
    'Text effects are disabled in this channel.',
  );
  assert(
    !cfg.textEffects.channels.length ||
      cfg.textEffects.channels.includes(channel.id) ||
      (channel.parentId && cfg.textEffects.channels.includes(channel.parentId)),
    'Use text effects in a configured text-effects channel.',
  );
  assert(
    !channel.isThread() || (!channel.archived && !channel.locked),
    'This thread is archived or locked.',
  );
}
async function destination(app: App, guildId: string, channelId: string, actorId: string) {
  const channel = await textChannel(app, guildId, channelId);
  available(app, channel);
  const [actor, me] = await Promise.all([
    channel.guild.members.fetch(actorId),
    channel.guild.members.fetchMe(),
  ]);
  const posting = [P.ViewChannel, channel.isThread() ? P.SendMessagesInThreads : P.SendMessages];
  assert(channel.permissionsFor(actor)?.has(posting), 'You cannot post in this channel.');
  assert(channel.permissionsFor(me)?.has(posting), 'The bot cannot post in this channel.');
  return { channel, actor, me };
}
async function sourceText(channel: GuildTextBasedChannel, actorId: string, messageId: string) {
  const [actor, me] = await Promise.all([
    channel.guild.members.fetch(actorId),
    channel.guild.members.fetchMe(),
  ]);
  for (const member of [actor, me])
    assert(
      channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]),
      'You and the bot need View Channel and Read Message History to transform an existing message.',
    );
  const source = await channel.messages
    .fetch({ message: messageId, force: true })
    .catch(() => null);
  assert(
    source && source.guildId === channel.guildId && source.channelId === channel.id,
    'The original message is missing or inaccessible.',
  );
  assert(
    !source.system && !source.flags.has(MessageFlags.Ephemeral),
    'Choose a normal channel message.',
  );
  assert(
    (source.content || displayText(source)).trim(),
    'That message has no text to transform. Attachments and embed contents are not converted.',
  );
  return source.content || displayText(source);
}
async function publish(
  channel: GuildTextBasedChannel,
  effect: TextEffect,
  input: string,
  options: TextOptions,
) {
  const result = transformText(effect, input, options);
  const long = result.length > 2000;
  if (long) {
    const me = await channel.guild.members.fetchMe();
    assert(
      channel.permissionsFor(me)?.has(P.AttachFiles),
      'The result exceeds 2,000 characters. The bot needs Attach Files to send the complete result.',
    );
  }
  await sendModern(channel, {
    ...(long
      ? { files: [new AttachmentBuilder(Buffer.from(result, 'utf8'), { name: `${effect}.txt` })] }
      : { content: result }),
    allowedMentions: noMentions,
    flags: MessageFlags.SuppressEmbeds,
  });
}

export async function transformMenu(app: App, i: MessageContextMenuCommandInteraction<'cached'>) {
  const { channel } = await destination(app, i.guildId, i.channelId, i.user.id);
  assert(i.targetMessage.channelId === channel.id, 'Select a message in this channel.');
  await sourceText(channel, i.user.id, i.targetId);
  const expires = (Date.now() + 300000).toString(36);
  await reply(i, {
    content:
      'Choose an effect. I’ll post the result in this channel. This private menu expires in five minutes.',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`textEffect:${i.user.id}:${i.targetId}:${expires}`)
          .setPlaceholder('Choose a text effect')
          .addOptions(textEffects.map((effect) => ({ label: effect, value: effect }))),
      ),
    ],
  });
}

export const text: Module = {
  commands: {
    text: async (app, i) => {
      const effect = i.options.getSubcommand() as TextEffect;
      const input = i.options.getString('text'),
        link = i.options.getString('message');
      assert(
        Boolean(input) !== Boolean(link),
        'Supply either text or a message link, using exactly one option.',
      );
      const { channel } = await destination(app, i.guildId, i.channelId, i.user.id);
      let original = input ?? '';
      if (link) {
        const match =
          /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d{17,22})\/(\d{17,22})\/(\d{17,22})\/?$/.exec(
            link,
          );
        assert(
          match && match[1] === i.guildId && match[2] === i.channelId,
          'Use a Discord message link from this same server and channel.',
        );
        original = await sourceText(channel, i.user.id, match[3]!);
      }
      const options: TextOptions = {};
      if (effect === 'uwuify') options.exclamations = i.options.getBoolean('exclamations') ?? false;
      if (effect === 'morse') options.decode = i.options.getBoolean('decode') ?? false;
      if (effect === 'emojify' || effect === 'faces')
        options.density = i.options.getInteger('density') ?? (effect === 'faces' ? 50 : 100);
      if (effect === 'zalgo')
        options.intensity = (i.options.getString('intensity') ??
          'medium') as TextOptions['intensity'];
      await publish(channel, effect, original, options);
      await reply(i, `Posted the ${effect} result in this channel.`);
    },
  },
  component: async (app, i) => {
    if (!i.isStringSelectMenu() || !i.customId.startsWith('textEffect:')) return false;
    const [, actor, message, expires] = i.customId.split(':');
    assert(actor === i.user.id, 'This text-effects menu belongs to another member.');
    assert(
      message && /^\d{17,22}$/.test(message) && expires && parseInt(expires, 36) > Date.now(),
      'This menu has expired. Open Apps → Transform text again.',
    );
    const effect = i.values[0] as TextEffect;
    assert(textEffects.includes(effect) && i.values.length === 1, 'Choose a valid text effect.');
    const { channel } = await destination(app, i.guildId, i.channelId, i.user.id);
    const original = await sourceText(channel, i.user.id, message);
    // Consume the menu before delivery; an uncertain send must not be retried by these controls.
    await reply(i, { content: 'Posting your transformed text…', components: [] });
    await publish(channel, effect, original, {});
    await reply(i, { content: `Posted the ${effect} result in this channel.`, components: [] });
    return true;
  },
};

const replyEffects: Record<string, TextEffect> = {
  uwu: 'uwuify',
  uwuify: 'uwuify',
  emojify: 'emojify',
  faces: 'faces',
  clap: 'clap',
  leet: 'leetspeak',
  leetspeak: 'leetspeak',
  morse: 'morse',
  reverse: 'reverse',
  zalgo: 'zalgo',
  unzalgo: 'unzalgo',
};
export async function replyTextCommand(app: App, message: Message): Promise<boolean> {
  if (
    !message.guild ||
    message.guildId !== app.guildId ||
    message.author.bot ||
    message.webhookId ||
    message.system
  )
    return false;
  const match =
    /^!(uwu|uwuify|emojify|faces|clap|leet|leetspeak|morse|reverse|zalgo|unzalgo)(?:\s+(decode|low|medium|high|\d{1,3}))?\s*$/i.exec(
      message.content,
    );
  if (!match) return false;
  const cfg = app.store.config(message.guildId);
  if (!cfg.modules.community || !cfg.textEffects.enabled) return true;
  let channel: GuildTextBasedChannel | undefined;
  try {
    ({ channel } = await destination(app, message.guildId, message.channelId, message.author.id));
    assert(
      message.reference?.messageId,
      'Reply to a message and send !uwu (or another effect). For your own text, use /text.',
    );
    const effect = replyEffects[match[1]!.toLowerCase()]!;
    const arg = match[2]?.toLowerCase();
    const options: TextOptions = {};
    if (arg) {
      if (effect === 'morse' && arg === 'decode') options.decode = true;
      else if (effect === 'zalgo' && ['low', 'medium', 'high'].includes(arg))
        options.intensity = arg as TextOptions['intensity'];
      else if (['emojify', 'faces'].includes(effect) && /^\d+$/.test(arg))
        options.density = Number(arg);
      else throw new UserError('That option does not match this effect. Use /help command:text.');
    }
    const original = await sourceText(channel, message.author.id, message.reference.messageId);
    await publish(channel, effect, original, options);
  } catch (error) {
    if (!(error instanceof UserError)) logError('text reply command', error);
    if (channel)
      await sendModern(channel, {
        content:
          error instanceof UserError
            ? error.message
            : 'The text effect could not be delivered. Check the channel before trying again.',
        allowedMentions: noMentions,
      }).catch(() => undefined);
  }
  return true;
}
