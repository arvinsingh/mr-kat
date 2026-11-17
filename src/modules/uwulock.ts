import { modernModal, modernEdit, displayText } from '../presentation.js';
import { logProfile } from '../log-profile.js';
import { logText } from '../log-format.js';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits as P,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Interaction, Component, Module } from '../types.js';
import { requirePermission, enabled } from '../permissions.js';
import { assert, duration } from '../util.js';
import { textChannel } from '../discord.js';
import { reply, confirm, noMentions, readOnlyResponse, type Confirmation } from '../ui.js';
import {
  activeLocks,
  uwuDeliveryIssues,
  lockKey,
  lockAuthority,
  lockGuildAuthority,
  uwuBlockReason,
  uwuScope,
  uwuWebhook,
  uwuBody,
  type UwuLock,
  type UwuPost,
} from '../uwulock.js';
import { SpamDetector } from '../spam.js';

interface Panel {
  actor: string;
  channel: string;
  member?: string;
  minutes: number;
  expires: number;
  scope?: 'server' | 'channel';
}
interface EditDraft {
  actor: string;
  post: string;
  channel: string;
  revision: string;
  expires: number;
}
async function staff(app: App, i: Interaction, channelId = i.channelId!) {
  enabled(app, i.guildId!, 'community');
  const channel = await textChannel(app, i.guildId!, channelId);
  await requirePermission(app, i, [P.ViewChannel, P.ManageMessages], channel);
  return channel;
}
export async function addUwuLock(
  app: App,
  i: Interaction,
  member: string,
  channelId: string | undefined,
  ms: number,
) {
  assert(Number.isSafeInteger(ms) && ms >= 10000 && ms <= 86400000, 'Choose 10 seconds to 1 day.');
  const lock: UwuLock = {
    actor: i.user.id,
    author: member,
    channel: channelId ?? '*',
    expires: Date.now() + ms,
    token: randomUUID(),
  };
  if (channelId) await lockAuthority(app, await staff(app, i, channelId), lock);
  else {
    await requirePermission(app, i, P.ManageMessages);
    await lockGuildAuthority(app, i.guild!, lock);
  }
  const key = lockKey(lock.channel, member);
  assert(
    activeLocks(app).length < 100 || app.store.get(app.guildId, 'uwuLock', key),
    'At most 100 active UwU locks.',
  );
  app.store.put(app.guildId, 'uwuLock', key, lock);
  await reply(i, {
    content: `<@${member}> is UwU locked ${uwuScope(lock.channel)} until <t:${Math.floor(lock.expires / 1000)}:F>. ${channelId ? '' : 'Applies in accessible supported channels where the bot and applying staff have the required permissions; protected destinations and exclusions are skipped. '}New text messages are replaced automatically. Unlocking affects future messages; it does not restore originals.`,
    components: [],
  });
}
async function remove(app: App, i: Interaction, member: string, channel: string | undefined) {
  if (!channel) {
    await requirePermission(app, i, P.ManageMessages);
    const locks = app.store
      .entries<UwuLock>(i.guildId!, 'uwuLock', 1000)
      .filter(({ data }) => data.author === member);
    assert(locks.length, 'That member has no UwU locks.');
    app.store.transaction(() => {
      for (const { key } of locks) app.store.delete(i.guildId!, 'uwuLock', key);
    });
    await reply(i, {
      content: `<@${member}> is fully unlocked. Removed ${locks.length} server-wide/channel lock(s). Existing transformed posts remain.`,
      components: [],
    });
    return;
  }
  await staff(app, i, channel);
  const key = lockKey(channel, member);
  assert(
    app.store.get(app.guildId!, 'uwuLock', key),
    'That member has no UwU lock in this channel.',
  );
  app.store.delete(app.guildId!, 'uwuLock', key);
  const global = app.store.get<UwuLock>(i.guildId!, 'uwuLock', lockKey('*', member));
  await reply(i, {
    content: `Removed the channel lock for <@${member}> in <#${channel}>.${global && global.expires > Date.now() ? ' A server-wide lock is still active; use /uwulock remove without channel to fully unlock them.' : ' They are unlocked here.'} Existing transformed posts remain.`,
    components: [],
  });
}
async function panel(app: App, i: Interaction, key?: string) {
  await requirePermission(app, i, P.ManageMessages);
  enabled(app, i.guildId!, 'community');
  assert(
    app.store.config(i.guildId!).uwuLock.enabled,
    'UwU Lock is disabled in configuration. Ask the owner to enable uwuLock.enabled with /config set.',
  );
  readOnlyResponse(i);
  let state = key ? app.store.get<Panel>(i.guildId!, 'uwuPanel', key) : undefined;
  if (!state) {
    key = randomUUID();
    state = {
      actor: i.user.id,
      channel: i.channelId!,
      scope: 'server',
      minutes: 10,
      expires: Date.now() + 600000,
    };
    app.store.put(i.guildId!, 'uwuPanel', key, state);
  }
  if (state.scope !== 'server') {
    const blocked = uwuBlockReason(app, await staff(app, i), app.store.config(i.guildId!));
    assert(!blocked, blocked ?? 'UwU Lock is unavailable here.');
  }
  await reply(i, {
    content: `**UwU Lock** · ${uwuScope(state.scope === 'server' ? '*' : state.channel)}\nMember: ${state.member ? `<@${state.member}>` : 'Choose below'} · Duration: ${state.minutes} minutes\nServer-wide covers accessible supported channels; protected destinations are skipped. Server-wide Unlock removes all locks for this member. New messages are reposted using their display name/avatar with Discord’s APP badge. Members can use Apps → Edit/Delete transformed message on their own posts. Controls expire in 10 minutes.`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`uwuPanel:scope:${key}`)
          .setPlaceholder('Choose lock scope')
          .addOptions(
            {
              label: 'Server-wide',
              value: 'server',
              default: state.scope === 'server',
              description: 'All accessible supported channels',
            },
            {
              label: 'This channel only',
              value: 'channel',
              default: state.scope !== 'server',
              description: 'Only the channel where this panel was opened',
            },
          ),
      ),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`uwuPanel:member:${key}`)
          .setPlaceholder('Choose a member')
          .setMinValues(1)
          .setMaxValues(1),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`uwuPanel:duration:${key}`)
          .setPlaceholder('Choose lock duration')
          .addOptions(
            [1, 5, 10, 30, 60, 360, 1440].map((minutes) => ({
              label: `${minutes} minutes`,
              value: String(minutes),
              default: minutes === state!.minutes,
            })),
          ),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`uwuPanel:add:${key}`)
          .setLabel('Start / replace lock')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!state.member),
        new ButtonBuilder()
          .setCustomId(`uwuPanel:remove:${key}`)
          .setLabel('Unlock member')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!state.member),
      ),
    ],
  });
}
export async function clearUwuLocks(app: App, i: Component, pending: Confirmation) {
  await requirePermission(app, i, P.ManageGuild);
  let count = 0;
  for (const item of pending.payload.locks as { key: string; token: string }[]) {
    if (app.store.get<UwuLock>(i.guildId, 'uwuLock', item.key)?.token !== item.token) continue;
    app.store.delete(i.guildId, 'uwuLock', item.key);
    count++;
  }
  await reply(i, `Removed ${count} UwU locks. New or changed locks since the preview were kept.`);
}
async function postAccess(app: App, i: Interaction, postId: string) {
  const post = app.store.get<UwuPost>(i.guildId!, 'uwuPost', postId);
  assert(
    post && post.author === i.user.id && post.channel === i.channelId,
    'Choose one of your own UwU Lock replacement messages in this channel.',
  );
  const channel = await textChannel(app, i.guildId!, post.channel);
  const [member, me] = await Promise.all([
    i.guild!.members.fetch(i.user.id),
    i.guild!.members.fetchMe(),
  ]);
  for (const who of [member, me])
    assert(
      channel
        .permissionsFor(who)
        ?.has([
          P.ViewChannel,
          P.ReadMessageHistory,
          channel.isThread() ? P.SendMessagesInThreads : P.SendMessages,
        ]),
      'You and the bot need access to this channel and its message history.',
    );
  assert(
    !channel.isThread() || (!channel.archived && !channel.locked),
    'This thread is archived or locked.',
  );
  const message = await channel.messages.fetch({ message: postId, force: true });
  assert(message.webhookId === post.webhook, 'This post no longer matches its UwU record.');
  return { post, channel, message, member };
}
const edits = new WeakMap<App, Set<string>>();
const stopping = new WeakSet<App>();
export async function stopUwuAuthorActions(app: App) {
  stopping.add(app);
  while (edits.get(app)?.size) await new Promise((resolve) => setTimeout(resolve, 50));
}
export async function uwuContext(app: App, i: MessageContextMenuCommandInteraction<'cached'>) {
  assert(!stopping.has(app), 'The bot is restarting. Try again shortly.');
  if (i.commandName === 'Edit transformed message') {
    // Open the modal immediately; all live access checks run again on submission.
    const post = app.store.get<UwuPost>(i.guildId, 'uwuPost', i.targetId);
    assert(
      post && post.author === i.user.id && post.channel === i.channelId,
      'Choose one of your own UwU Lock replacement messages in this channel.',
    );
    const key = randomUUID();
    app.store.put(i.guildId, 'uwuDraft', key, {
      actor: i.user.id,
      post: i.targetId,
      channel: i.channelId,
      revision: post.revision,
      expires: Date.now() + 300000,
    } satisfies EditDraft);
    await i.showModal(
      modernModal(
        new ModalBuilder()
          .setCustomId(`uwuEdit:${key}`)
          .setTitle('Edit your UwU message')
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId('text')
                .setLabel('Your text (UwU conversion applied)')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(4000)
                .setValue(post.input),
            ),
          ),
      ),
    );
    return;
  }
  const { post, channel, message } = await postAccess(app, i, i.targetId);
  let running = edits.get(app);
  assert(!stopping.has(app), 'The bot is restarting. Try again shortly.');
  if (!running) edits.set(app, (running = new Set()));
  assert(!running.has(i.targetId), 'This post already has an action in progress.');
  running.add(i.targetId);
  try {
    const hook = await uwuWebhook(app, channel, post.webhook);
    await hook.deleteMessage(i.targetId, channel.isThread() ? channel.id : undefined);
    app.store.delete(i.guildId, 'uwuPost', i.targetId);
    await app.audit(
      i.guildId,
      'messages',
      'UwU message deleted by author',
      `Original: ${logText(post.input)}\n---\nDisplayed: ${logText(message.content || displayText(message))}`,
      {
        profile: logProfile(app, i.user.id, i.member, i.user),
        reference: `<#${channel.id}>`,
        dividers: true,
        source: { channel: channel.id, message: i.targetId, author: i.user.id },
      },
    );
    await reply(i, 'Your transformed message was deleted.');
  } finally {
    running.delete(i.targetId);
  }
}
async function editPost(app: App, i: Component) {
  assert(!stopping.has(app), 'The bot is restarting. Try again shortly.');
  assert(i.isModalSubmit(), 'Use the edit form.');
  const key = i.customId.split(':')[1]!;
  const draft = app.store.get<EditDraft>(i.guildId, 'uwuDraft', key);
  assert(
    draft &&
      draft.actor === i.user.id &&
      draft.channel === i.channelId &&
      draft.expires > Date.now(),
    'This form expired or belongs to another member. Open Edit transformed message again.',
  );
  const { post, channel, message, member } = await postAccess(app, i, draft.post);
  assert(
    post.revision === draft.revision,
    'This message changed since you opened the form. Open a new form.',
  );
  let running = edits.get(app);
  if (!running) edits.set(app, (running = new Set()));
  assert(!running.has(draft.post), 'This post already has an action in progress.');
  const input = i.fields.getTextInputValue('text').trim();
  const cfg = app.store.config(i.guildId);
  if (
    cfg.modules.automod &&
    !member.permissions.has(P.Administrator) &&
    !cfg.automod.exemptChannels.includes(channel.id) &&
    ![...cfg.protectedRoles, ...cfg.automod.exemptRoles].some((id) => member.roles.cache.has(id))
  ) {
    // Check each edit independently so the alert-suppression window cannot bypass content rules.
    const reason = new SpamDetector().check(
      i.guildId,
      {
        id: draft.post,
        user: i.user.id,
        channel: channel.id,
        content: input,
        mentions: [...input.matchAll(/<@!?\d+>|<@&\d+>|@everyone|@here/g)].length,
        attachments: message.attachments.size,
        time: Date.now(),
      },
      cfg.automod,
    );
    if (reason) {
      await app.audit(i.guildId, 'automod', 'UwU edit blocked', `Reason: ${reason}.`, {
        profile: logProfile(app, i.user.id, i.member, i.user),
        reference: `<#${channel.id}>`,
      });
      assert(false, `The edit was blocked by AutoMod: ${reason}.`);
    }
  }
  const body = uwuBody(input, post.source, post.prefix);
  assert(
    !body.files.length ||
      channel.permissionsFor(await i.guild.members.fetchMe())?.has(P.AttachFiles),
    'The bot needs Attach Files to preserve the full result.',
  );
  const keep = message.attachments.filter(
    (a) => a.id !== post.bodyAttachment && a.name !== `uwulock-${post.source}.txt`,
  );
  assert(keep.size + body.files.length <= 10, 'Too many attachments to preserve the edited text.');
  assert(!stopping.has(app), 'The bot is restarting. Try again shortly.');
  assert(!running.has(draft.post), 'This post already has an action in progress.');
  assert(
    app.store.get<UwuPost>(i.guildId, 'uwuPost', draft.post)?.revision === draft.revision,
    'This message changed while the edit was being prepared. Open a new form.',
  );
  running.add(draft.post);
  app.store.delete(i.guildId, 'uwuDraft', key);
  try {
    const hook = await uwuWebhook(app, channel, post.webhook);
    // Advance the revision before the API call: other open forms cannot replay an uncertain edit.
    const next = { ...post, input, revision: randomUUID() };
    app.store.put(i.guildId, 'uwuPost', draft.post, next);
    const edited = await hook.editMessage(
      draft.post,
      modernEdit({
        ...body,
        components: keep.map((attachment) => ({
          type: 13 as const,
          file: { url: `attachment://${attachment.name}` },
          ...(attachment.spoiler ? { spoiler: true } : {}),
        })),
        allowedMentions: noMentions,
        withComponents: true,
        attachments: keep.map((a) => ({ id: a.id })),
        ...(channel.isThread() ? { threadId: channel.id } : {}),
      }),
    );
    next.bodyAttachment = edited.attachments.find(
      (a) => a.name === `uwulock-${post.source}.txt`,
    )?.id;
    app.store.put(i.guildId, 'uwuPost', draft.post, next);
    await app.audit(
      i.guildId,
      'messages',
      'UwU message edited by author',
      `Before: ${logText(post.input)}\n---\nAfter: ${logText(input)}`,
      {
        profile: logProfile(app, i.user.id, i.member, i.user),
        reference: message.url,
        dividers: true,
        source: { channel: channel.id, message: draft.post, author: i.user.id },
      },
    );
    await reply(i, 'Your message was updated.');
  } finally {
    running.delete(draft.post);
  }
}
export const uwulock: Module = {
  commands: {
    uwulock: async (app, i) => {
      await requirePermission(app, i, P.ManageMessages);
      const action = i.options.getSubcommand();
      if (action === 'panel') return panel(app, i);
      if (action === 'add')
        return addUwuLock(
          app,
          i,
          i.options.getUser('member', true).id,
          i.options.getChannel('channel')?.id,
          duration(i.options.getString('duration') ?? '10m', 86400000),
        );
      if (action === 'remove')
        return remove(
          app,
          i,
          i.options.getUser('member', true).id,
          i.options.getChannel('channel')?.id,
        );
      if (action === 'clear') {
        await requirePermission(app, i, P.ManageGuild);
        const locks = activeLocks(app).map(({ key, data }) => ({ key, token: data.token }));
        return confirm(
          app,
          i,
          `Remove ${locks.length} active UwU locks across the server? Existing posts stay.`,
          'uwuClear',
          { locks },
        );
      }
      if (action === 'list') {
        const locks = activeLocks(app);
        const issues = uwuDeliveryIssues(app);
        const rows = locks.map(
          ({ data }) =>
            `<@${data.author}> · ${uwuScope(data.channel)} · expires <t:${Math.floor(data.expires / 1000)}:R> · by <@${data.actor}>`,
        );
        const report = [
          ...rows,
          ...issues.map(
            ({ key, data }) =>
              `Needs review: original ${key}; channel ${data.channel ?? 'unknown'}; author ${data.author ?? 'unknown'}; state ${data.state}; replacement ${data.replacement ?? 'unknown'}. Inspect both copies; no automatic retry.`,
          ),
        ];
        await reply(i, {
          content:
            (rows.length
              ? rows.slice(0, 10).join('\n') +
                (rows.length > 10 ? `\n${rows.length} active locks total. Full list attached.` : '')
              : 'No active UwU locks.') +
            (issues.length
              ? `\n${issues.length} unresolved deliveries; review the attached report and admin log.`
              : ''),
          files:
            rows.length > 10 || issues.length > 0
              ? [new AttachmentBuilder(Buffer.from(report.join('\n')), { name: 'uwu-locks.txt' })]
              : [],
        });
        return;
      }
      const stats = app.store
        .entries<{ count: number }>(i.guildId, 'uwuStats', 10000)
        .sort((a, b) => b.data.count - a.data.count)
        .slice(0, 10);
      await reply(
        i,
        stats.length
          ? `**UwU leaderboard**\n${stats.map((item, index) => `${index + 1}. <@${item.key}> — ${item.data.count} converted messages`).join('\n')}`
          : 'No successful conversions yet.',
      );
    },
  },
  component: async (app, i) => {
    if (i.customId.startsWith('uwuEdit:')) {
      await editPost(app, i);
      return true;
    }
    if (!i.customId.startsWith('uwuPanel:')) return false;
    const [, action, key] = i.customId.split(':');
    const state = app.store.get<Panel>(i.guildId, 'uwuPanel', key!);
    assert(
      state &&
        state.actor === i.user.id &&
        state.channel === i.channelId &&
        state.expires > Date.now(),
      'This panel expired or belongs to another member. Run /uwulock panel.',
    );
    await requirePermission(app, i, P.ManageMessages);
    enabled(app, i.guildId, 'community');
    if (action === 'member' && i.isUserSelectMenu()) state.member = i.values[0];
    else if (action === 'scope' && i.isStringSelectMenu()) {
      assert(i.values[0] === 'server' || i.values[0] === 'channel', 'Choose a listed scope.');
      state.scope = i.values[0];
    } else if (action === 'duration' && i.isStringSelectMenu()) {
      const minutes = Number(i.values[0]);
      assert([1, 5, 10, 30, 60, 360, 1440].includes(minutes), 'Choose a listed duration.');
      state.minutes = minutes;
    } else if (action === 'add' || action === 'remove') {
      assert(state.member, 'Choose a member.');
      // Consume before mutation; old buttons cannot repeat a change after dismissing the panel.
      app.store.delete(i.guildId, 'uwuPanel', key!);
      if (action === 'add')
        await addUwuLock(
          app,
          i,
          state.member,
          state.scope === 'server' ? undefined : state.channel,
          state.minutes * 60000,
        );
      else await remove(app, i, state.member, state.scope === 'server' ? undefined : state.channel);
      return true;
    } else assert(false, 'Unknown UwU panel action.');
    app.store.put(i.guildId, 'uwuPanel', key!, state);
    await panel(app, i, key);
    return true;
  },
};
