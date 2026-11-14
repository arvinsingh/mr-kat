import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits as P,
  ChannelType,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Module, Interaction } from '../types.js';
import { owner, enabled, requirePermission, botPermission } from '../permissions.js';
import { textChannel } from '../discord.js';
import { modernModal, modernEdit, sendModern } from '../presentation.js';
import { noMentions, reply, linkButtons, colors } from '../ui.js';
import { safe, assert } from '../util.js';
import { directMessage } from '../dm.js';

export const suggestionStates = [
  'open',
  'under_review',
  'needs_info',
  'accepted',
  'in_progress',
  'implemented',
  'declined',
] as const;
export interface Suggestion {
  actor: string;
  authorName?: string;
  text: string;
  state: string;
  reason?: string;
  channel: string;
  message: string;
  thread?: string;
  created?: number;
  replyControl?: string;
}
const active = new Set<string>();
const label = (state: string) =>
  state.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
export function suggestionCard(key: string, item: Suggestion, guild: string) {
  const accent =
    item.state === 'declined'
      ? colors.error
      : ['accepted', 'implemented'].includes(item.state)
        ? colors.success
        : item.state === 'in_progress'
          ? colors.info
          : colors.suggestion;
  return {
    components: [
      new ContainerBuilder()
        .setAccentColor(accent)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## Suggestion ${key} · ${label(item.state)}\n**By:** <@${item.actor}>${item.authorName ? ` · ${safe(item.authorName, 100)}` : ''}\n\n${safe(item.text, 1900)}${item.reason ? `\n\n**Update:** ${safe(item.reason, 650)}` : ''}`,
          ),
        )
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent('Join the conversation'))
            .setButtonAccessory(
              item.thread
                ? new ButtonBuilder()
                    .setURL(`https://discord.com/channels/${guild}/${item.thread}`)
                    .setLabel('Comment')
                    .setStyle(ButtonStyle.Link)
                : new ButtonBuilder()
                    .setCustomId(`suggestion:comment:${key}`)
                    .setLabel('Comment')
                    .setStyle(ButtonStyle.Primary),
            ),
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent('Staff: update status or request details'),
            )
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`suggestion:review:${key}`)
                .setLabel('Review')
                .setStyle(ButtonStyle.Secondary),
            ),
        ),
    ],
    allowedMentions: noMentions,
  };
}
async function access(app: App, i: Interaction, key: string) {
  enabled(app, i.guildId!, 'community');
  const item = app.store.get<Suggestion>(i.guildId!, 'suggestion', key);
  assert(item, 'Suggestion not found.');
  const channel = await textChannel(app, i.guildId!, item.channel);
  const member = await i.guild!.members.fetch(i.user.id);
  assert(
    channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]),
    'You cannot view this suggestion.',
  );
  return { item, channel };
}
async function threadFor(app: App, guild: string, key: string, item: Suggestion) {
  const channel = await textChannel(app, guild, item.channel);
  if (item.thread) {
    const thread = await channel.guild.channels.fetch(item.thread);
    assert(
      thread?.isThread() && thread.parentId === item.channel && !thread.locked,
      'The discussion is unavailable or locked.',
    );
    if (thread.archived) await thread.setArchived(false);
    await replyControl(app, guild, key, item, thread);
    return thread;
  }
  await botPermission(channel.guild, [P.CreatePublicThreads, P.SendMessagesInThreads], channel);
  const message = await channel.messages.fetch(item.message);
  const thread = await message.startThread({
    name: `Suggestion ${key}`,
    autoArchiveDuration: 1440,
    reason: 'Suggestion discussion',
  });
  item.thread = thread.id;
  app.store.put(guild, 'suggestion', key, item);
  await replyControl(app, guild, key, item, thread);
  return thread;
}
async function replyControl(
  app: App,
  guild: string,
  key: string,
  item: Suggestion,
  thread: Parameters<typeof sendModern>[0],
) {
  if (item.replyControl) return;
  const control = await sendModern(thread, {
    components: [
      new ContainerBuilder().addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              'Staff: reply here under your name, or as the bot.',
            ),
          )
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`suggestion:write:${key}`)
              .setLabel('Reply as bot')
              .setStyle(ButtonStyle.Secondary),
          ),
      ),
    ],
    allowedMentions: noMentions,
  });
  item.replyControl = control.id;
  app.store.put(guild, 'suggestion', key, item);
}
async function updateStatus(app: App, i: Interaction, key: string, state: string, reason: string) {
  const { item, channel } = await access(app, i, key);
  await requirePermission(app, i, P.ManageMessages, channel);
  assert(
    suggestionStates.includes(state as (typeof suggestionStates)[number]),
    'Unknown suggestion status.',
  );
  if (item.state === state && item.reason === reason) {
    await reply(i, 'This update is already saved.');
    return;
  }
  item.state = state;
  item.reason = reason;
  app.store.put(i.guildId!, 'suggestion', key, item);
  const thread = await threadFor(app, i.guildId!, key, item).catch(() => undefined);
  const refreshed = await channel.messages
    .fetch(item.message)
    .then((message) => message.edit(modernEdit(suggestionCard(key, item, i.guildId!))))
    .then(() => true)
    .catch(() => false);
  const discussed = thread
    ? await sendModern(thread, {
        content: `**Status: ${label(state)}**\n${safe(reason, 1900)}`,
        allowedMentions: noMentions,
      })
        .then(() => true)
        .catch(() => false)
    : false;
  const url = `https://discord.com/channels/${i.guildId}/${item.channel}/${item.message}`;
  const delivery = await directMessage(
    app,
    item.actor,
    `Suggestion ${key} · ${label(state)}`,
    `${safe(reason, 1900)}\n\n${state === 'needs_info' ? 'Please add more details using Comment on your suggestion.' : 'Use Comment to continue the discussion.'}`,
    'suggestion',
    linkButtons([{ label: 'View suggestion', url }]),
  );
  await app.audit(
    i.guildId!,
    'admin',
    'Suggestion updated',
    `Suggestion ${key} · ${state}\nStaff: <@${i.user.id}>\nNotification: ${delivery}`,
  );
  await reply(
    i,
    `Suggestion updated. DM: ${delivery}.${refreshed ? '' : ' The card could not be refreshed.'}${discussed ? '' : ' The discussion update could not be confirmed.'}`,
  );
}
export const suggestions: Module = {
  commands: {
    suggest: async (app, i) => {
      enabled(app, i.guildId, 'community');
      const action = i.options.getSubcommand();
      if (action === 'setup') {
        owner(i);
        await requirePermission(app, i, P.ManageGuild);
        const channel = await textChannel(app, i.guildId, i.options.getChannel('channel', true).id);
        assert(channel.type === ChannelType.GuildText, 'Choose a normal text channel.');
        await botPermission(
          i.guild,
          [P.SendMessages, P.ReadMessageHistory, P.CreatePublicThreads, P.SendMessagesInThreads],
          channel,
        );
        const cfg = app.store.config(i.guildId);
        cfg.suggestionChannel = channel.id;
        app.store.setConfig(i.guildId, cfg, i.user.id);
        await reply(i, `Suggestions will be posted in <#${channel.id}>.`);
        return;
      }
      if (action === 'create') {
        const channelId = app.store.config(i.guildId).suggestionChannel;
        assert(channelId, 'The owner must run /suggest setup first.');
        const channel = await textChannel(app, i.guildId, channelId);
        const member = await i.guild.members.fetch(i.user.id);
        assert(
          channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]),
          'You cannot view the suggestions channel.',
        );
        await botPermission(
          i.guild,
          [P.SendMessages, P.CreatePublicThreads, P.SendMessagesInThreads],
          channel,
        );
        const key = randomUUID().slice(0, 8);
        const item: Suggestion = {
          actor: i.user.id,
          authorName: member.displayName ?? i.user.username,
          text: i.options.getString('text', true),
          state: 'open',
          channel: channel.id,
          message: '',
          created: Date.now(),
        };
        const post = await sendModern(channel, suggestionCard(key, item, i.guildId));
        item.message = post.id;
        app.store.put(i.guildId, 'suggestion', key, item);
        await threadFor(app, i.guildId, key, item).catch(() => undefined);
        if (item.thread)
          await post.edit(modernEdit(suggestionCard(key, item, i.guildId))).catch(() => undefined);
        await reply(
          i,
          `Suggestion posted: ${post.url ?? `https://discord.com/channels/${i.guildId}/${channel.id}/${post.id}`}`,
        );
        return;
      }
      const key = i.options.getString('id', true);
      assert(!active.has(key), 'This suggestion is being updated.');
      active.add(key);
      try {
        await updateStatus(
          app,
          i,
          key,
          i.options.getString('state', true),
          i.options.getString('reason', true),
        );
      } finally {
        active.delete(key);
      }
    },
  },
  component: async (app, i) => {
    if (!i.customId.startsWith('suggestion:')) return false;
    const [, action, key] = i.customId.split(':');
    assert(key && ['comment', 'review', 'write'].includes(action!), 'Invalid suggestion control.');
    const { item, channel } = await access(app, i, key);
    if (action === 'review' || action === 'write')
      await requirePermission(app, i, P.ManageMessages, channel);
    if (i.isButton()) {
      assert(
        action === 'write'
          ? i.channelId === item.thread && i.message.id === item.replyControl
          : i.message.id === item.message && i.channelId === item.channel,
        'Invalid suggestion panel.',
      );
      if (action === 'comment') {
        assert(!active.has(key), 'This suggestion is being updated.');
        active.add(key);
        try {
          const thread = await threadFor(app, i.guildId!, key, item);
          await i.message
            .edit(modernEdit(suggestionCard(key, item, i.guildId!)))
            .catch(() => undefined);
          await reply(i, {
            content: 'Join the discussion.',
            components: linkButtons([
              {
                label: 'Open discussion',
                url: `https://discord.com/channels/${i.guildId}/${thread.id}`,
              },
            ]),
          });
        } finally {
          active.delete(key);
        }
        return true;
      }
      const form = new ModalBuilder()
        .setCustomId(i.customId)
        .setTitle(action === 'review' ? 'Review suggestion' : 'Reply as bot');
      if (action === 'review')
        form.addLabelComponents(
          new LabelBuilder().setLabel('Status').setStringSelectMenuComponent(
            new StringSelectMenuBuilder().setCustomId('state').addOptions(
              suggestionStates.map((value) => ({
                label: label(value),
                value,
                default: value === item.state,
              })),
            ),
          ),
        );
      form.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('text')
            .setLabel(action === 'review' ? 'Reason or request' : 'Your comment')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1900)
            .setRequired(true),
        ),
      );
      await i.showModal(modernModal(form));
      return true;
    }
    if (!i.isModalSubmit()) return false;
    assert(!active.has(key), 'This suggestion is being updated.');
    active.add(key);
    try {
      const receipt = i.id;
      assert(
        !app.store.get(i.guildId!, 'suggestionAction', receipt),
        'This form has already been submitted.',
      );
      app.store.put(i.guildId!, 'suggestionAction', receipt, { key, actor: i.user.id });
      if (action === 'review')
        await updateStatus(
          app,
          i,
          key,
          i.fields.getStringSelectValues('state')[0]!,
          i.fields.getTextInputValue('text'),
        );
      else {
        const thread = await threadFor(app, i.guildId!, key, item);
        const member = await i.guild!.members.fetch(i.user.id);
        assert(
          thread
            .permissionsFor(member)
            ?.has([P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads]),
          'You cannot post in this discussion.',
        );
        await sendModern(thread, {
          content: `${action === 'write' ? '**Staff reply**' : `**${safe(i.member.displayName, 100)}** · <@${i.user.id}>`}\n${safe(i.fields.getTextInputValue('text'), 1900)}`,
          allowedMentions: noMentions,
        });
        if (action === 'write')
          await app.audit(
            i.guildId!,
            'admin',
            'Suggestion staff reply',
            `Suggestion ${key} · Staff: <@${i.user.id}>\nDiscussion: <#${thread.id}>`,
          );
        await reply(i, `Comment posted in <#${thread.id}>.`);
      }
    } finally {
      active.delete(key);
    }
    return true;
  },
};
