import { updatedControls, sendModern, modernModal, modernEdit } from '../presentation.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits as P,
  type GuildTextBasedChannel,
} from 'discord.js';
import type { App, Interaction, Module } from '../types.js';
import { owner, requirePermission, botPermission } from '../permissions.js';
import { assert, safe, UserError } from '../util.js';
import { embed, noMentions, reply, linkButtons } from '../ui.js';
import { destination, textChannel } from '../discord.js';
import { directMessage } from '../dm.js';
import { createHash } from 'node:crypto';

export interface Confession {
  id: number;
  text: string;
  privacy: 'unlinked' | 'staff' | 'internal';
  state:
    'pending' | 'review_failed' | 'publishing' | 'published' | 'rejected' | 'uncertain' | 'removed';
  channel: string;
  reviewChannel?: string;
  reviewRequired?: boolean;
  created: number;
  reviewMessage?: string;
  message?: string;
  reviewer?: string;
  reason?: string;
  parent?: number;
  thread?: string;
  closed?: boolean;
  threadError?: boolean;
  label?: string;
  controlsVersion?: number;
}
interface Participants {
  users: Record<string, { label: string; muted: boolean; active?: boolean }>;
  next: number;
}
interface Subscriptions {
  users: Record<string, { muted: boolean }>;
}
const discussions = new Map<string, Promise<void>>();
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = discussions.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  discussions.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (discussions.get(key) === current) discussions.delete(key);
  }
}
function controls(id: number, post = id) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`confession:reply:${id}:${post}`)
        .setLabel('Reply')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`confession:mute:${id}:${post}`)
        .setLabel('Mute / unmute DMs')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`confession:report:${id}:${post}`)
        .setLabel('Report discussion')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}
function rootItem(app: App, guild: string, id: number): Confession {
  const item = app.store.get<Confession>(guild, 'confession', String(id));
  assert(item && !item.parent && item.state === 'published', 'This discussion is unavailable.');
  return item;
}
async function discussionAccess(app: App, i: Interaction, root: Confession) {
  const channel = await textChannel(app, i.guildId!, root.thread ?? root.channel);
  const actor = await i.guild!.members.fetch(i.user.id);
  assert(
    channel.permissionsFor(actor)?.has([P.ViewChannel, P.ReadMessageHistory]),
    'You no longer have access to this discussion.',
  );
  return channel;
}
export async function ensureConfessionThread(app: App, guild: string, root: Confession) {
  assert(
    root.message && !root.closed && app.store.config(guild).confessions.privacy === 'internal',
    'Reply threads require internal linking and a retained, open discussion.',
  );
  const link = app.store.get<{ author: string }>(guild, 'confessionLink', String(root.id));
  if (link && !app.store.get(guild, 'confessionParticipants', String(root.id)))
    app.store.put(guild, 'confessionParticipants', String(root.id), {
      users: { [link.author]: { label: 'OP', muted: false } },
      next: 1,
    } satisfies Participants);
  const reopen = async (thread: GuildTextBasedChannel) => {
    assert(
      thread.isThread() && thread.type !== ChannelType.PrivateThread,
      'The confession reply destination must be a public thread.',
    );
    assert(
      !thread.locked,
      'Staff have locked this discussion. Ask them to use /confession reopen.',
    );
    if (thread.archived) {
      await botPermission(thread.guild, P.SendMessagesInThreads, thread);
      await thread.setArchived(false, 'Anonymous confession reply');
    }
    return thread;
  };
  if (root.thread) {
    const existing = await app.client.channels.fetch(root.thread).catch((error: unknown) => {
      if ((error as { code?: number }).code === 10003) return null;
      throw error;
    });
    if (existing) return reopen(await textChannel(app, guild, existing.id));
    delete root.thread;
    app.store.put(guild, 'confession', String(root.id), root);
  }
  const publication = await textChannel(app, guild, root.channel);
  await botPermission(
    publication.guild,
    [P.CreatePublicThreads, P.SendMessagesInThreads, P.EmbedLinks],
    publication,
  );
  const message = await publication.messages.fetch(root.message);
  assert(
    message.author.id === app.client.user!.id,
    'The original confession is not owned by this bot.',
  );
  const thread = await reopen(
    message.thread ??
      (await message.startThread({
        name: `Confession #${root.id}`,
        autoArchiveDuration: 1440,
        reason: 'Anonymous confession discussion',
      })),
  );
  root.thread = thread.id;
  root.threadError = false;
  app.store.put(guild, 'confession', String(root.id), root);
  // Do not add real participants to the thread membership list.
  await message.edit(updatedControls(message, controls(root.id))).catch(() => undefined);
  return thread;
}
export async function reconcileConfessionControls(app: App) {
  let cfg = app.store.config(app.guildId);
  if (!app.store.get(app.guildId, 'system', 'confessionRepliesV2')) {
    if (cfg.confessions.enabled && cfg.confessions.privacy === 'unlinked') {
      cfg.confessions.privacy = 'internal';
      app.store.setConfig(app.guildId, cfg, app.client.user!.id);
      await app.audit(
        app.guildId,
        'admin',
        'Confession replies enabled',
        'New forms disclose internal ID linking for anonymous replies and DM notifications. Older unlinked authors remain unknown; no identities have been recovered or exposed.',
      );
    }
    app.store.put(app.guildId, 'system', 'confessionRepliesV2', { at: Date.now() });
    cfg = app.store.config(app.guildId);
  }
  if (!cfg.confessions.enabled || cfg.confessions.privacy !== 'internal') return;
  const candidates = app.store
    .entries<Confession>(app.guildId, 'confession', 10000)
    .filter(({ data }) => data.state === 'published' && data.message && data.controlsVersion !== 2)
    .slice(0, 25);
  for (const { key, data } of candidates) {
    try {
      const channel = await textChannel(app, app.guildId, data.channel);
      const message = await channel.messages.fetch(data.message!);
      if (message.author.id !== app.client.user!.id) continue;
      await message.edit(updatedControls(message, controls(data.parent ?? data.id, data.id)));
      data.controlsVersion = 2;
      app.store.put(app.guildId, 'confession', key, data);
    } catch {
      /* Missing posts or permissions can be repaired after the server configuration is corrected. */
    }
  }
}
export function confessionPrivacy(mode: 'unlinked' | 'staff' | 'internal'): string {
  return mode === 'unlinked'
    ? 'Anonymous to members. The bot retains no author-to-confession link. Discord still processes your interaction.'
    : 'Anonymous to members, moderators and the owner through the bot. IDs are kept internally for OP labels, replies and DMs; no identity lookup command exists. Host/database operators can access stored data. Discord processes interactions.';
}
async function reviewCard(app: App, guild: string, item: Confession) {
  assert(item.reviewChannel, 'This submission has no review channel.');
  const review = await textChannel(app, guild, item.reviewChannel);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`confession:approve:${item.id}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`confession:reject:${item.id}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );
  const message = await sendModern(review, {
    embeds: [
      embed(
        `Confession #${item.id} · review`,
        `${item.parent ? `Reply to confession #${item.parent}\n\n` : ''}${safe(item.text, 1900)}\n\nPrivacy at submission: ${item.privacy}. No author is displayed in this review card.`,
        'warning',
      ),
    ],
    components: [row],
    allowedMentions: noMentions,
  });
  const current = app.store.get<Confession>(guild, 'confession', String(item.id));
  if (
    !current ||
    !['pending', 'review_failed'].includes(current.state) ||
    current.reviewMessage !== item.reviewMessage
  ) {
    await message.delete().catch(() => undefined);
    throw new UserError(
      'This confession review changed while the card was being sent. Check its current status.',
    );
  }
  item.reviewMessage = message.id;
  item.state = 'pending';
  app.store.put(guild, 'confession', String(item.id), item);
  app.store.put(guild, 'logMessage', message.id, {
    channel: item.reviewChannel,
    kind: 'reports',
    created: Date.now(),
  });
  return message;
}
async function publishConfession(
  app: App,
  guild: string,
  item: Confession,
  channel: GuildTextBasedChannel,
) {
  const root = item.parent ? rootItem(app, guild, item.parent) : item;
  assert(!root.closed, 'This discussion is closed.');
  if (item.parent) {
    const thread = await ensureConfessionThread(app, guild, root);
    assert(
      thread.id === channel.id && channel.isThread() && !channel.archived && !channel.locked,
      'The reply thread is closed or unavailable.',
    );
    assert(app.store.config(guild).confessions.enabled, 'Confessions are disabled.');
  }
  let participants = app.store.get<Participants>(
    guild,
    'confessionParticipants',
    String(root.id),
  ) ?? { users: {}, next: 1 };
  const link = app.store.get<{ author: string }>(guild, 'confessionLink', String(item.id));
  if (link) {
    if (!participants.users[link.author]) {
      assert(
        Object.keys(participants.users).length < 100,
        'This discussion has reached its participant limit.',
      );
      participants.users[link.author] = {
        label: item.parent ? `Anonymous ${participants.next++}` : 'OP',
        muted: false,
        active: false,
      };
    }
    item.label = participants.users[link.author]!.label;
    app.store.put(guild, 'confessionParticipants', String(root.id), participants);
  }
  try {
    const message = await sendModern(channel, {
      embeds: [
        embed(
          item.parent
            ? `Confession #${root.id} · ${item.label ?? 'Anonymous'} · Reply #${item.id}`
            : `Confession #${item.id}`,
          safe(item.text, 1900),
          'confession',
        ),
      ],
      components:
        app.store.config(guild).confessions.privacy === 'internal'
          ? controls(root.id, item.id)
          : [],
      nonce: createHash('sha256')
        .update(`${guild}:confession:${item.id}`)
        .digest('hex')
        .slice(0, 24),
      enforceNonce: true,
      allowedMentions: noMentions,
    });
    item.message = message.id;
    item.state = 'published';
    if (item.privacy !== 'unlinked') item.controlsVersion = 2;
    app.store.put(guild, 'confession', String(item.id), item);
  } catch {
    item.state = 'uncertain';
    app.store.put(guild, 'confession', String(item.id), item);
    throw new UserError(
      'Publication could not be confirmed. Check the destination before retrying manually; this submission will not be automatically posted again.',
    );
  }
  if (link) {
    participants = app.store.get<Participants>(guild, 'confessionParticipants', String(root.id))!;
    participants.users[link.author]!.active = true;
    app.store.put(guild, 'confessionParticipants', String(root.id), participants);
  }
  if (item.parent && link) {
    app.store.put(guild, 'confession', String(root.id), root);
    // IDs and delivery receipts live only in internal entries, never in /jobs or staff logs.
    const recipients = new Set(Object.keys(participants.users));
    if (channel.isThread()) {
      const members = await channel.members.fetch().catch(() => null);
      if (members) for (const member of members.values()) recipients.add(member.id);
    }
    for (const user of recipients) {
      const latest = app.store.get<Participants>(guild, 'confessionParticipants', String(root.id));
      if (
        user === link.author ||
        user === app.client.user!.id ||
        latest?.users[user]?.muted === true ||
        latest?.users[user]?.active === false ||
        app.store.get<Subscriptions>(guild, 'confessionSubscriptions', String(root.id))?.users[user]
          ?.muted
      )
        continue;
      const receipt = `${item.id}:${user}`;
      if (app.store.get(guild, 'confessionDelivery', receipt)) continue;
      try {
        const current = rootItem(app, guild, root.id);
        if (
          current.closed ||
          !app.store.config(guild).confessions.enabled ||
          app.store.get<Confession>(guild, 'confession', String(item.id))?.state !== 'published'
        )
          break;
        const member = await channel.guild.members.fetch(user);
        if (member.user?.bot) continue;
        if (!channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory])) continue;
        if (
          rootItem(app, guild, root.id).closed ||
          app.store.get<Participants>(guild, 'confessionParticipants', String(root.id))?.users[user]
            ?.muted === true ||
          app.store.get<Subscriptions>(guild, 'confessionSubscriptions', String(root.id))?.users[
            user
          ]?.muted
        )
          continue;
        app.store.put(guild, 'confessionDelivery', receipt, { root: root.id, state: 'started' });
        const state = await directMessage(
          app,
          user,
          `Confession #${root.id} · new reply`,
          `${safe(item.label ?? 'Anonymous')} replied:\n\n${safe(item.text, 1900)}\n\nOpen the reply and press Reply to respond anonymously. Mute with /confess-notifications id:${root.id} enabled:false in the server. Replies to this DM are not monitored.`,
          'confession',
          linkButtons([
            {
              label: 'View reply',
              url: `https://discord.com/channels/${guild}/${channel.id}/${item.message}`,
            },
          ]),
        );
        app.store.put(guild, 'confessionDelivery', receipt, { root: root.id, state });
      } catch {
        /* Missing members or inaccessible discussions receive no notification. */
      }
    }
  }
}
export async function submitConfession(
  app: App,
  i: Interaction,
  text: string,
  disclosedPrivacy: string,
  disclosedReview = true,
  parent?: number,
) {
  const cfg = app.store.config(i.guildId!).confessions;
  assert(
    cfg.enabled && cfg.channel && (!cfg.reviewRequired || cfg.reviewChannel),
    'Confessions are not configured. Ask the server owner to use /confession setup.',
  );
  assert(
    disclosedPrivacy === cfg.privacy,
    'The confession privacy setting changed while this form was open. Run /confess again to read the current policy.',
  );
  assert(
    disclosedReview === cfg.reviewRequired,
    'The publishing mode changed while this form was open. Run /confess again to read the current policy.',
  );
  const content = text.trim();
  const root = parent ? rootItem(app, i.guildId!, parent) : undefined;
  if (root) {
    assert(
      cfg.privacy === 'internal' && !root.closed,
      'Anonymous replies need internal linking and an open discussion.',
    );
    await discussionAccess(app, i, root);
  }
  assert(
    content.length >= 1 && content.length <= 1900,
    'Write a confession between 1 and 1900 characters.',
  );
  assert(
    app.store
      .entries<Confession>(i.guildId!, 'confession', 1000)
      .filter((e) => ['pending', 'review_failed', 'publishing', 'uncertain'].includes(e.data.state))
      .length < 100,
    'The confession queue is full. Ask staff to review unresolved submissions.',
  );
  if (root) {
    const thread = await serial(`${i.guildId}:${root.id}`, () =>
      ensureConfessionThread(app, i.guildId!, rootItem(app, i.guildId!, root.id)),
    );
    root.thread = thread.id;
  }
  const publication = await textChannel(app, i.guildId!, root?.thread ?? cfg.channel);
  assert(
    !root || root.thread,
    'This discussion has no reply thread. Ask staff to run /confession thread.',
  );
  await botPermission(
    publication.guild,
    [
      root ? P.SendMessagesInThreads : P.SendMessages,
      P.EmbedLinks,
      ...(!root && cfg.privacy === 'internal'
        ? [P.CreatePublicThreads, P.SendMessagesInThreads]
        : []),
    ],
    publication,
  );
  assert(
    !publication.isThread() || (!publication.archived && !publication.locked),
    'This thread is archived or locked. Ask staff to reopen it.',
  );
  if (cfg.reviewRequired) await textChannel(app, i.guildId!, cfg.reviewChannel!);
  const current = app.store.config(i.guildId!).confessions;
  assert(
    current.enabled &&
      current.privacy === cfg.privacy &&
      current.reviewRequired === cfg.reviewRequired &&
      current.channel === cfg.channel &&
      current.reviewChannel === cfg.reviewChannel,
    'Confession settings changed. Run /confess again to read the current policy.',
  );
  const number = app.store.nextSequence(i.guildId!, 'confession');
  const item: Confession = {
    id: number,
    text: content,
    privacy: cfg.privacy,
    state: cfg.reviewRequired ? 'pending' : 'publishing',
    channel: root?.thread ?? cfg.channel,
    ...(parent ? { parent } : {}),
    reviewChannel: cfg.reviewChannel,
    reviewRequired: cfg.reviewRequired,
    created: Date.now(),
  };
  app.store.transaction(() => {
    if (i.id) {
      assert(
        !app.store.get(i.guildId!, 'confessionSubmission', i.id),
        'This form was already submitted. Check its outcome before opening a new form.',
      );
      app.store.put(i.guildId!, 'confessionSubmission', i.id, { confession: number });
    }
    app.store.put(i.guildId!, 'confession', String(number), item);
    if (cfg.privacy === 'internal')
      app.store.put(i.guildId!, 'confessionLink', String(number), { author: i.user.id });
  });
  if (!cfg.reviewRequired) {
    try {
      await serial(`${i.guildId}:${parent ?? number}`, () =>
        publishConfession(app, i.guildId!, item, publication),
      );
    } catch (error) {
      if (item.state === 'publishing') {
        item.state = 'rejected';
        app.store.put(i.guildId!, 'confession', String(number), item);
      }
      throw error;
    }
    await reply(
      i,
      `Confession #${number} posted. Read /help command:confess for privacy information.`,
    );
    return;
  }
  try {
    await reviewCard(app, i.guildId!, item);
  } catch {
    item.state = 'review_failed';
    app.store.put(i.guildId!, 'confession', String(number), item);
    throw new UserError(
      `Confession #${number} was saved, but its staff review card could not be delivered. Ask staff to run /confession review for that number. Do not immediately resubmit.`,
    );
  }
  await reply(
    i,
    `Confession #${number} submitted for review. Read /help command:confess for privacy information.`,
  );
}
async function showConfessionForm(app: App, i: Interaction, parent?: number) {
  const cfg = app.store.config(i.guildId!).confessions;
  assert(
    cfg.enabled && cfg.channel && (!cfg.reviewRequired || cfg.reviewChannel),
    'Confessions are not configured. Ask the owner to use /confession setup.',
  );
  if (parent) {
    const root = rootItem(app, i.guildId!, parent);
    assert(
      !root.closed && cfg.privacy === 'internal',
      'This discussion is closed or does not support linked replies.',
    );
  }
  const modal = new ModalBuilder()
    .setCustomId(
      `confess:submit:${cfg.privacy}:${cfg.reviewRequired ? 'review' : 'instant'}:${parent ?? 0}`,
    )
    .setTitle(parent ? `Reply to confession #${parent}` : 'Anonymous confession')
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        parent ? 'Your reply is anonymous.' : 'Your confession is anonymous.',
      ),
    )
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('text')
          .setLabel(parent ? 'Your reply' : 'Your confession')
          .setPlaceholder(parent ? 'Write your reply here…' : 'Write your confession here…')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1900),
      ),
    );
  assert('showModal' in i, 'Open a new confession form.');
  await i.showModal(modernModal(modal));
  // Return immediately so submitting the modal is never blocked by background thread creation.
}
export async function confessionNotifications(
  app: App,
  i: Interaction,
  id: number,
  enabled: boolean,
) {
  const root = rootItem(app, i.guildId!, id);
  const channel = await discussionAccess(app, i, root);
  const participants = app.store.get<Participants>(
    i.guildId!,
    'confessionParticipants',
    String(id),
  );
  const member = participants?.users[i.user.id];
  if (!member || member.active === false) {
    assert(
      channel.isThread() && (await channel.members.fetch(i.user.id).catch(() => null)),
      'Notifications are available after you have published a submission or joined this discussion thread.',
    );
  }
  if (member) {
    member.muted = !enabled;
    app.store.put(i.guildId!, 'confessionParticipants', String(id), participants);
  }
  const preferences = app.store.get<Subscriptions>(
    i.guildId!,
    'confessionSubscriptions',
    String(id),
  ) ?? { users: {} };
  preferences.users[i.user.id] = { muted: !enabled };
  app.store.put(i.guildId!, 'confessionSubscriptions', String(id), preferences);
  await reply(
    i,
    `Reply DMs ${enabled ? 'enabled' : 'muted'} for confession #${id}. This changes notifications, not the bot-internal participant record.`,
  );
}
export const confessions: Module = {
  commands: {
    confess: async (app, i) => {
      await showConfessionForm(app, i, i.options.getInteger('reply_to') ?? undefined);
    },
    'confess-notifications': async (app, i) => {
      await confessionNotifications(
        app,
        i,
        i.options.getInteger('id', true),
        i.options.getBoolean('enabled', true),
      );
    },
    confession: async (app, i) => {
      await requirePermission(app, i, P.ManageMessages);
      const action = i.options.getSubcommand();
      const cfg = app.store.config(i.guildId);
      // Retired commands must not expose legacy mappings, even to the server owner.
      assert(action !== 'author', 'Author lookup is unavailable to everyone, including the owner.');
      if (action === 'mode') {
        owner(i);
        const value = i.options.getString('value', true);
        assert(value === 'review' || value === 'instant', 'Choose review or instant.');
        if (value === 'review') {
          assert(
            cfg.confessions.reviewChannel,
            'Choose a staff-review channel with /confession setup before enabling review.',
          );
          const review = await destination(app, i, cfg.confessions.reviewChannel);
          assert(
            review.type === ChannelType.GuildText &&
              !review.permissionsFor(i.guild.roles.everyone)?.has(P.ViewChannel),
            'Choose a staff-only text review channel.',
          );
          assert(
            review.id !== cfg.confessions.channel,
            'Publication and review must use different channels.',
          );
          await botPermission(i.guild, [P.ViewChannel, P.SendMessages, P.EmbedLinks], review);
        }
        cfg.confessions.reviewRequired = value === 'review';
        app.store.setConfig(i.guildId, cfg, i.user.id);
        await reply(
          i,
          `Confession publishing mode: ${value === 'review' ? 'staff review required' : 'instant, no staff review'}. Existing queued submissions still require their original review.\n${confessionPrivacy(cfg.confessions.privacy)}`,
        );
        return;
      }
      if (action === 'setup') {
        owner(i);
        const channel = await destination(app, i, i.options.getChannel('channel', true).id);
        const reviewRequired =
          i.options.getBoolean('review_required') ?? cfg.confessions.reviewRequired;
        const reviewId =
          i.options.getChannel('review_channel')?.id ?? cfg.confessions.reviewChannel;
        const review = reviewId ? await destination(app, i, reviewId) : undefined;
        assert(
          channel.type === ChannelType.GuildText &&
            (!review || review.type === ChannelType.GuildText),
          'Choose standard text channels for confessions and review.',
        );
        assert(
          !reviewRequired || review,
          'Staff review mode needs a staff-only review_channel, or choose review_required:false.',
        );
        if (review) {
          assert(channel.id !== review.id, 'Use different publication and staff-review channels.');
          assert(
            !review.permissionsFor(i.guild.roles.everyone)?.has(P.ViewChannel),
            'The review channel is public to @everyone. Choose a staff-only review channel.',
          );
          await botPermission(i.guild, [P.ViewChannel, P.SendMessages, P.EmbedLinks], review);
        }
        await botPermission(i.guild, [P.ViewChannel, P.SendMessages, P.EmbedLinks], channel);
        const privacy = i.options.getString('privacy', true);
        assert(
          privacy === 'unlinked' || privacy === 'internal',
          'Choose unlinked or internal privacy.',
        );
        if (privacy === 'internal')
          await botPermission(
            i.guild,
            [P.CreatePublicThreads, P.SendMessagesInThreads, P.ReadMessageHistory],
            channel,
          );
        cfg.confessions = {
          ...cfg.confessions,
          enabled: true,
          channel: channel.id,
          reviewChannel: review?.id,
          reviewRequired,
          privacy,
        };
        app.store.setConfig(i.guildId, cfg, i.user.id);
        await reply(
          i,
          `Confessions enabled in <#${channel.id}>. ${reviewRequired ? `Review cards go to <#${review!.id}>; staff approval is required.` : 'Instant mode: submissions post immediately without staff approval.'}\n${confessionPrivacy(privacy)}\nMembers submit with /confess.`,
        );
        return;
      }
      if (action === 'status') {
        await reply(
          i,
          `Confessions: ${cfg.confessions.enabled ? 'enabled' : 'disabled'}\nPublishing: ${cfg.confessions.reviewRequired ? 'staff review required' : 'instant (no review)'}\nPublication: ${cfg.confessions.channel ? `<#${cfg.confessions.channel}>` : 'not configured'}\nStaff review: ${cfg.confessions.reviewChannel ? `<#${cfg.confessions.reviewChannel}>` : 'not configured'}\n${confessionPrivacy(cfg.confessions.privacy)}\nCommand cooldown: off.`,
        );
        return;
      }
      if (action === 'list') {
        await reply(
          i,
          app.store
            .entries<Confession>(i.guildId, 'confession', 15)
            .map((e) => `#${e.data.id} · ${e.data.state} · ${safe(e.data.text, 80)}`)
            .join('\n') || 'No retained confessions.',
        );
        return;
      }
      const number = i.options.getInteger('id', true),
        item = app.store.get<Confession>(i.guildId, 'confession', String(number));
      assert(item, 'Confession not found in retained records.');
      if (action === 'thread' || action === 'close' || action === 'reopen') {
        const root = rootItem(app, i.guildId, number);
        const publication = await textChannel(app, i.guildId, root.channel);
        await requirePermission(app, i, P.ManageMessages, publication);
        await serial(`${i.guildId}:${number}`, async () => {
          const current = rootItem(app, i.guildId, number);
          if (action === 'reopen') {
            if (current.thread) {
              const thread = await textChannel(app, i.guildId, current.thread);
              assert(thread.isThread(), 'The discussion thread is unavailable.');
              await botPermission(i.guild, P.ManageThreads, thread);
              await thread.setArchived(false, 'Confession discussion reopened');
              await thread.setLocked(false, 'Confession discussion reopened');
            }
            current.closed = false;
            app.store.put(i.guildId, 'confession', String(number), current);
            await reply(i, 'Discussion reopened. Anonymous reply buttons can be used again.');
          } else if (action === 'thread') {
            const thread = await ensureConfessionThread(app, i.guildId, current);
            await reply(
              i,
              `Discussion ready: <#${thread.id}>. Use Reply anonymously; typing directly exposes your account.`,
            );
          } else {
            if (current.thread) {
              const thread = await textChannel(app, i.guildId, current.thread);
              assert(thread.isThread(), 'The discussion thread is unavailable.');
              await botPermission(i.guild, P.ManageThreads, thread);
              await thread.setLocked(true, 'Confession discussion closed');
              await thread.setArchived(true, 'Confession discussion closed');
            }
            current.closed = true;
            app.store.put(i.guildId, 'confession', String(number), current);
            await reply(
              i,
              'Discussion closed. New anonymous replies and notifications are stopped.',
            );
          }
        });
        return;
      }
      if (action === 'review') {
        assert(item.reviewChannel, 'This submission was not queued for staff review.');
        assert(
          item.state === 'pending' || item.state === 'review_failed',
          'Only pending/undelivered review cards can be resent.',
        );
        await requirePermission(
          app,
          i,
          P.ManageMessages,
          await textChannel(app, i.guildId, item.reviewChannel),
        );
        const message = await reviewCard(app, i.guildId, item);
        await reply(i, `Review card ready: ${message.url}`);
        return;
      }
      assert(
        action === 'remove' && item.state === 'published' && item.message,
        'Only published confessions can be removed.',
      );
      await serial(`${i.guildId}:${item.parent ?? number}`, async () => {
        const current = app.store.get<Confession>(i.guildId, 'confession', String(number));
        assert(current?.state === 'published' && current.message, 'This post is already removed.');
        const channel = await textChannel(app, i.guildId, current.channel);
        await requirePermission(app, i, P.ManageMessages, channel);
        if (!current.parent && current.thread) {
          const thread = await textChannel(app, i.guildId, current.thread);
          assert(thread.isThread(), 'The discussion thread is unavailable.');
          await botPermission(i.guild, P.ManageThreads, thread);
          await thread.setLocked(true, 'Confession removed');
          await thread.setArchived(true, 'Confession removed');
        }
        const message = await channel.messages.fetch(current.message);
        assert(message.author.id === app.client.user!.id, 'This message is not owned by this bot.');
        await message.delete();
        current.state = 'removed';
        current.closed = true;
        current.reason = i.options.getString('reason', true);
        current.reviewer = i.user.id;
        app.store.put(i.guildId, 'confession', String(number), current);
        await app.audit(
          i.guildId,
          'moderation',
          `Confession #${number} removed`,
          `By <@${i.user.id}>. ${safe(current.reason)}`,
        );
        await reply(i, 'Confession removed.');
      });
    },
  },
  component: async (app, i) => {
    if (i.isModalSubmit() && i.customId.startsWith('confess:submit:')) {
      await submitConfession(
        app,
        i,
        i.fields.getTextInputValue('text'),
        i.customId.split(':')[2]!,
        i.customId.split(':')[3] !== 'instant',
        Number(i.customId.split(':')[4]) || undefined,
      );
      return true;
    }
    if (!i.isButton() || !i.customId.startsWith('confession:')) return false;
    const [, action, key, post] = i.customId.split(':');
    const number = Number(key);
    assert(Number.isSafeInteger(number) && number > 0, 'Invalid confession reference.');
    if (['reply', 'mute', 'report'].includes(action!)) {
      const root = rootItem(app, i.guildId, number);
      const source = app.store.get<Confession>(i.guildId, 'confession', post ?? key!);
      assert(
        source &&
          source.message === i.message.id &&
          (source.id === number || source.parent === number) &&
          source.state === 'published' &&
          source.channel === i.channelId,
        'This discussion control is stale.',
      );
      if (action === 'reply') {
        await showConfessionForm(app, i, number);
        return true;
      }
      await discussionAccess(app, i, root);
      if (action === 'mute') {
        const current = app.store.get<Participants>(i.guildId, 'confessionParticipants', key!)
          ?.users[i.user.id];
        const subscription = app.store.get<Subscriptions>(
          i.guildId,
          'confessionSubscriptions',
          key!,
        )?.users[i.user.id];
        await confessionNotifications(
          app,
          i,
          number,
          subscription?.muted ?? current?.muted ?? false,
        );
      }
      if (action === 'report') {
        assert(
          app.store.config(i.guildId).logs.reports,
          'Staff have not configured a reports destination.',
        );
        await app.audit(
          i.guildId,
          'reports',
          'Confession discussion reported',
          `Discussion #${number}; post #${source.id}. https://discord.com/channels/${i.guildId}/${source.channel}/${source.message}\nNo participant or reporter identities are included.`,
        );
        await reply(i, 'The discussion was flagged to staff.');
      }
      return true;
    }
    await requirePermission(app, i, P.ManageMessages, i.channel ?? undefined);
    assert(action === 'approve' || action === 'reject', 'Unknown confession action.');
    let item = app.store.get<Confession>(i.guildId, 'confession', key!);
    assert(
      item &&
        item.state === 'pending' &&
        item.reviewMessage === i.message.id &&
        item.reviewChannel === i.channelId,
      'This confession review is stale or already handled.',
    );
    assert(app.store.config(i.guildId).confessions.enabled, 'Confessions are disabled.');
    const publication =
      action === 'approve' ? await textChannel(app, i.guildId, item.channel) : undefined;
    if (publication) await requirePermission(app, i, P.ManageMessages, publication);
    if (publication)
      await botPermission(
        i.guild,
        [publication.isThread() ? P.SendMessagesInThreads : P.SendMessages, P.EmbedLinks],
        publication,
      );
    // Re-read after permission checks, then claim synchronously before the send.
    // Competing approvals cannot publish twice, and preflight failures leave it pending.
    item = app.store.get<Confession>(i.guildId, 'confession', key!);
    assert(
      item && item.state === 'pending' && item.reviewMessage === i.message.id,
      'This confession review is stale or already handled.',
    );
    assert(app.store.config(i.guildId).confessions.enabled, 'Confessions are disabled.');
    item.state = action === 'approve' ? 'publishing' : 'rejected';
    item.reviewer = i.user.id;
    app.store.put(i.guildId, 'confession', key!, item);
    if (action === 'approve') {
      try {
        await serial(`${i.guildId}:${item.parent ?? item.id}`, () =>
          publishConfession(app, i.guildId, item!, publication!),
        );
      } catch (error) {
        if (item.state === 'publishing') {
          item.state = 'pending';
          app.store.put(i.guildId, 'confession', key!, item);
        }
        throw error;
      }
    }
    const finalState =
      app.store.get<Confession>(i.guildId, 'confession', key!)?.state ?? item.state;
    await i.message.edit(
      modernEdit({
        embeds: [
          embed(
            `Confession #${item.id} · ${finalState}`,
            `${item.parent ? `Reply to confession #${item.parent}\n\n` : ''}${safe(item.text, 1900)}`,
            action === 'approve' ? 'success' : 'error',
          ),
        ],
        components: [],
        allowedMentions: noMentions,
      }),
    );
    await reply(i, `Confession #${item.id} ${item.state}.`);
    return true;
  },
};
