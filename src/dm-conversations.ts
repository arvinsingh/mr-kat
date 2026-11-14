import {
  ChannelType,
  PermissionFlagsBits as P,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Message,
} from 'discord.js';
import type { App, Interaction, Module } from './types.js';
import { assert, safe } from './util.js';
import { textChannel } from './discord.js';
import { sendModern, displayText, modernModal } from './presentation.js';
import { noMentions, reply } from './ui.js';
import { requirePermission, botPermission } from './permissions.js';
import { directMessage, type Delivery } from './dm.js';

interface Conversation {
  user: string;
  channel: string;
  thread: string;
}
const pending = new WeakMap<App, Map<string, Promise<unknown>>>();
async function serial<T>(app: App, user: string, run: () => Promise<T>): Promise<T> {
  let queues = pending.get(app);
  if (!queues) pending.set(app, (queues = new Map()));
  const next = (queues.get(user) ?? Promise.resolve()).catch(() => undefined).then(run);
  queues.set(user, next);
  try {
    return await next;
  } finally {
    if (queues.get(user) === next) queues.delete(user);
  }
}
async function conversation(app: App, user: string) {
  const cfg = app.store.config(app.guildId);
  assert(cfg.logs.dm, 'Configure the DM log channel with /logs setup.');
  const channel = await textChannel(app, app.guildId, cfg.logs.dm);
  assert(
    channel.type === ChannelType.GuildText &&
      !channel.permissionsFor(channel.guild.roles.everyone)?.has(P.ViewChannel),
    'The DM log must be a private text channel.',
  );
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (!overwrite.allow.has(P.ViewChannel)) continue;
    assert(
      [app.client.user!.id, channel.guild.ownerId, ...cfg.staffRoles].includes(overwrite.id) ||
        !!channel.guild.roles.cache.get(overwrite.id)?.permissions.has(P.Administrator),
      'Remove non-staff View Channel overrides from the DM log.',
    );
  }
  await botPermission(
    channel.guild,
    [P.SendMessages, P.ReadMessageHistory, P.CreatePublicThreads, P.SendMessagesInThreads],
    channel,
  );
  const current = app.store.get<Conversation>(app.guildId, 'dmConversation', user);
  if (current?.channel === channel.id) {
    const thread = await channel.guild.channels
      .fetch(current.thread)
      .catch((error: { code?: number }) => {
        if (error.code === 10003) return null;
        throw error;
      });
    if (thread) {
      assert(
        thread.isThread() && thread.parentId === channel.id && !thread.locked,
        'The DM conversation is locked or unavailable.',
      );
      if (thread.archived) await thread.setArchived(false);
      return thread;
    }
  }
  const recipient = await app.client.users.fetch(user);
  const thread = await channel.threads.create({
    name: `dm-${recipient.username}-${user}`.slice(0, 95),
    type: ChannelType.PublicThread,
    autoArchiveDuration: 1440,
    reason: 'Private staff DM conversation',
  });
  const record = { user, channel: channel.id, thread: thread.id };
  app.store.put(app.guildId, 'dmConversation', user, record);
  app.store.put(app.guildId, 'dmThread', thread.id, record);
  await sendModern(thread, {
    components: [
      new ContainerBuilder().addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## DM conversation\n<@${user}> · ${safe(recipient.username, 100)}\nUse Reply or /dm reply. Other thread messages stay internal.`,
            ),
          )
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`dm:reply:${thread.id}`)
              .setLabel('Reply')
              .setStyle(ButtonStyle.Primary),
          ),
      ),
    ],
    allowedMentions: noMentions,
  });
  return thread;
}
export async function logOutgoingDM(
  app: App,
  user: string,
  title: string,
  text: string,
  delivery: Delivery,
  attachments: string[],
) {
  if (!app.guildId || !app.store.config(app.guildId).logs.dm) return;
  await serial(app, user, async () => {
    const thread = await conversation(app, user);
    await sendModern(thread, {
      content: `## Bot → member · ${delivery}\n**${safe(title, 256)}**\n${text}${attachments.length ? `\n\nAttachments: ${attachments.map((name) => safe(name, 120)).join(', ')}` : ''}`,
      allowedMentions: noMentions,
    });
  });
}
export async function incomingDM(app: App, message: Message) {
  if (message.guild || message.author.bot || message.webhookId) return false;
  const cfg = app.store.config(app.guildId);
  if (!cfg.logs.dm || !cfg.modules.messages) return true;
  if (
    message.reference?.messageId &&
    app.store.get(app.guildId, 'privateDM', message.reference.messageId)
  ) {
    await sendModern(message.author, {
      content:
        'Use the original feature’s controls to reply. This private notification was not forwarded to staff.',
      allowedMentions: noMentions,
    });
    return true;
  }
  await serial(app, message.author.id, async () => {
    if (app.store.get(app.guildId, 'dmReceipt', message.id)) return;
    const known = app.store.get<Conversation>(app.guildId, 'dmConversation', message.author.id);
    if (!known) {
      const guild = await app.client.guilds.fetch(app.guildId);
      const member = await guild.members
        .fetch(message.author.id)
        .catch((error: { code?: number }) => {
          if (error.code === 10007) return null;
          throw error;
        });
      if (!member) return;
    }
    const thread = await conversation(app, message.author.id);
    app.store.put(app.guildId, 'dmReceipt', message.id, {
      state: 'started',
      user: message.author.id,
      thread: thread.id,
    });
    try {
      const attachments = [...message.attachments.values()]
        .map((a) => `[${safe(a.name, 100)}](${a.url})`)
        .join('\n');
      await sendModern(thread, {
        content: `## Member → staff\n**${safe(message.author.username, 100)}** · <@${message.author.id}>\n${message.content || displayText(message) || '[No text]'}${attachments ? '\n\n' + attachments : ''}`,
        allowedMentions: noMentions,
      });
    } catch {
      app.store.put(app.guildId, 'dmReceipt', message.id, {
        state: 'uncertain',
        user: message.author.id,
        thread: thread.id,
      });
      await sendModern(message.author, {
        content: 'Delivery could not be confirmed. Contact staff in the server if needed.',
        allowedMentions: noMentions,
      }).catch(() => undefined);
      return;
    }
    app.store.put(app.guildId, 'dmReceipt', message.id, {
      state: 'sent',
      user: message.author.id,
      thread: thread.id,
    });
  }).catch(async () => {
    await sendModern(message.author, {
      content: 'The staff inbox is unavailable. Contact staff in the server.',
      allowedMentions: noMentions,
    }).catch(() => undefined);
  });
  return true;
}
async function threadAccess(app: App, i: Interaction, threadId: string) {
  const record = app.store.get<Conversation>(i.guildId!, 'dmThread', threadId);
  assert(
    record && record.channel === app.store.config(i.guildId!).logs.dm && i.channelId === threadId,
    'Use this in a configured DM conversation thread.',
  );
  const thread = await textChannel(app, i.guildId!, threadId);
  assert(
    thread.isThread() && thread.parentId === record.channel && !thread.locked,
    'The conversation is locked or unavailable.',
  );
  await requirePermission(app, i, P.ManageGuild, thread);
  return record;
}
export async function replyToDM(app: App, i: Interaction, text: string) {
  assert(app.store.config(i.guildId!).modules.messages, 'DM conversations are disabled.');
  const record = await threadAccess(app, i, i.channelId!);
  assert(text.trim() && text.length <= 1900, 'Use 1–1,900 characters.');
  const key = i.id;
  assert(!app.store.get(i.guildId!, 'dmReceipt', key), 'This reply was already attempted.');
  app.store.put(i.guildId!, 'dmReceipt', key, { state: 'started', user: record.user });
  const delivery = await directMessage(app, record.user, `${i.guild!.name} · staff reply`, text);
  app.store.put(i.guildId!, 'dmReceipt', key, {
    state: delivery,
    user: record.user,
    actor: i.user.id,
  });
  await reply(i, `DM: ${delivery}.`);
}
export const dmConversations: Module = {
  component: async (app, i) => {
    if (!i.customId.startsWith('dm:reply:')) return false;
    assert(app.store.config(i.guildId!).modules.messages, 'DM conversations are disabled.');
    const [, , threadId, actor] = i.customId.split(':');
    assert(threadId, 'Invalid conversation.');
    await threadAccess(app, i, threadId);
    if (actor) assert(actor === i.user.id, 'Open your own reply form.');
    if (i.isButton()) {
      await i.showModal(
        modernModal(
          new ModalBuilder()
            .setCustomId(`dm:reply:${threadId}:${i.user.id}`)
            .setTitle('Reply to member')
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId('text')
                  .setLabel('Message')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(1900)
                  .setRequired(true),
              ),
            ),
        ),
      );
    } else if (i.isModalSubmit()) await replyToDM(app, i, i.fields.getTextInputValue('text'));
    return true;
  },
};
