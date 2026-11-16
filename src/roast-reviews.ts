import { randomUUID } from 'node:crypto';
import {
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits as P,
  type Message,
} from 'discord.js';
import type { App, Command, Component } from './types.js';
import { assert, safe, logError } from './util.js';
import { requirePermission } from './permissions.js';
import { modernEdit, sendModern } from './presentation.js';
import { noMentions, reply, colors, linkButtons } from './ui.js';
import { directMessage } from './dm.js';
import { roastLines } from './roast-lines.js';
import {
  normalizeRoast,
  publicRoastBoard,
  roastSubmissions,
  validateRoast,
  type RoastSubmission,
} from './roasts.js';

export function roastSubmissionCard(key: string, item: RoastSubmission) {
  const state = item.status[0]!.toUpperCase() + item.status.slice(1);
  const card = new ContainerBuilder()
    .setAccentColor(
      item.status === 'approved'
        ? colors.success
        : item.status === 'pending'
          ? colors.warning
          : colors.error,
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## Roast ${key} · ${state}\n**Suggested by:** <@${item.actor}> · ${safe(item.authorName, 100)}\n\n${item.text}\n\n-# ${item.status === 'pending' ? 'Staff review required.' : `Updated <t:${Math.floor((item.reviewedAt ?? item.created) / 1000)}:f>.`}`,
      ),
    );
  if (item.status === 'pending')
    card.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`roastReview:approve:${key}`)
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`roastReview:reject:${key}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  return { components: [card], allowedMentions: noMentions };
}

const renders = new WeakMap<App, Map<string, Promise<boolean>>>();
export async function renderRoastSubmission(
  app: App,
  key: string,
  supplied?: Pick<Message, 'edit'>,
): Promise<boolean> {
  let queue = renders.get(app);
  if (!queue) renders.set(app, (queue = new Map()));
  const next = (queue.get(key) ?? Promise.resolve())
    .catch(() => false)
    .then(async () => {
      try {
        let item = app.store.get<RoastSubmission>(app.guildId, 'roastSubmission', key);
        if (!item?.message) return false;
        const message =
          supplied ??
          (await (await publicRoastBoard(app, item.channel)).messages.fetch(item.message));
        item = app.store.get<RoastSubmission>(app.guildId, 'roastSubmission', key)!;
        await message.edit(modernEdit(roastSubmissionCard(key, item)));
        const current = app.store.get<RoastSubmission>(app.guildId, 'roastSubmission', key);
        if (current?.status === item.status && current.reviewedAt === item.reviewedAt) {
          current.needsRender = false;
          app.store.put(app.guildId, 'roastSubmission', key, current);
        }
        return true;
      } catch (error) {
        logError('roast review card', error);
        return false;
      }
    });
  queue.set(key, next);
  try {
    return await next;
  } finally {
    if (queue.get(key) === next) queue.delete(key);
  }
}
export async function reconcileRoastReviews(app: App) {
  for (const entry of roastSubmissions(app)
    .filter((entry) => entry.data.needsRender)
    .slice(0, 25))
    await renderRoastSubmission(app, entry.key);
}

export async function submitRoast(app: App, i: Command) {
  const cfg = app.store.config(i.guildId);
  assert(cfg.modules.community && cfg.roast.enabled, 'Roasts are disabled.');
  assert(
    cfg.roast.reviewChannel,
    'The owner must choose a public submission channel in /roast setup first.',
  );
  const text = validateRoast(i.options.getString('text', true));
  const board = await publicRoastBoard(app, cfg.roast.reviewChannel);
  const member = await i.guild.members.fetch(i.user.id);
  assert(
    board.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]),
    'You cannot view the roast submission channel.',
  );
  const currentConfig = app.store.config(i.guildId);
  assert(
    currentConfig.modules.community &&
      currentConfig.roast.enabled &&
      currentConfig.roast.reviewChannel === board.id,
    'Roast submission settings changed. Run the command again.',
  );
  const normalized = normalizeRoast(text),
    key = randomUUID().slice(0, 8);
  const item: RoastSubmission = {
    actor: i.user.id,
    authorName: member.displayName,
    text,
    normalized,
    status: 'pending',
    channel: board.id,
    message: '',
    created: Date.now(),
  };
  app.store.transaction(() => {
    assert(
      !app.store.get(i.guildId, 'roastReceipt', i.id),
      'This submission was already attempted.',
    );
    const entries = roastSubmissions(app);
    assert(entries.length < 2000, 'The custom roast library is full. Ask the owner to review it.');
    assert(
      entries.filter((entry) => entry.data.status === 'pending').length < 100,
      'There are already 100 pending roasts. Staff need to review them first.',
    );
    assert(
      entries.filter((entry) => entry.data.status === 'pending' && entry.data.actor === i.user.id)
        .length < 10,
      'You already have 10 pending roasts. Wait for staff to review them.',
    );
    assert(
      !roastLines.some((line) => normalizeRoast(line) === normalized) &&
        !entries.some((entry) => entry.data.normalized === normalized),
      'That roast is already in the library or has already been submitted.',
    );
    app.store.put(i.guildId, 'roastReceipt', i.id, { key, kind: 'submission' });
    app.store.put(i.guildId, 'roastSubmission', key, item);
  });
  try {
    const message = await sendModern(board, {
      ...roastSubmissionCard(key, item),
      nonce: key,
      enforceNonce: true,
    });
    const current = app.store.get<RoastSubmission>(i.guildId, 'roastSubmission', key)!;
    current.message = message.id;
    app.store.put(i.guildId, 'roastSubmission', key, current);
    await reply(
      i,
      `Submitted for staff approval: https://discord.com/channels/${i.guildId}/${board.id}/${message.id}`,
    );
  } catch {
    await reply(
      i,
      'Submission delivery could not be confirmed. Check the submission channel before trying again.',
    );
  }
}

export async function reviewRoast(app: App, i: Component) {
  const [, action, key] = i.customId.split(':');
  assert(
    i.isButton() && key && ['approve', 'reject'].includes(action!),
    'Invalid roast review control.',
  );
  let item = app.store.get<RoastSubmission>(i.guildId!, 'roastSubmission', key);
  assert(item, 'Roast submission not found.');
  const board = await publicRoastBoard(app, item.channel);
  await requirePermission(app, i, P.ManageMessages, board);
  assert(
    i.channelId === item.channel &&
      i.message.author.id === app.client.user!.id &&
      (!item.message || i.message.id === item.message),
    'Invalid roast submission card.',
  );
  const changed = app.store.transaction(() => {
    item = app.store.get<RoastSubmission>(i.guildId!, 'roastSubmission', key)!;
    if (item.status !== 'pending') return false;
    item.message = i.message.id;
    item.status = action === 'approve' ? 'approved' : 'rejected';
    item.reviewedBy = i.user.id;
    item.reviewedAt = Date.now();
    item.needsRender = true;
    app.store.put(i.guildId!, 'roastSubmission', key, item);
    return true;
  });
  const rendered = await renderRoastSubmission(app, key, i.message);
  if (!changed) {
    await reply(i, `This submission is already ${item.status}.`);
    return;
  }
  const url = `https://discord.com/channels/${i.guildId}/${item.channel}/${item.message}`;
  const delivery = await directMessage(
    app,
    item.actor,
    `Roast submission · ${item.status}`,
    `${item.text}\n\n${item.status === 'approved' ? 'Added to the random roast pool.' : 'This submission was not added to the roast pool.'}`,
    'info',
    linkButtons([{ label: 'View submission', url }]),
  );
  await app.audit(
    i.guildId!,
    'admin',
    'Roast submission reviewed',
    `Roast ${key} · ${item.status}\nStaff: <@${i.user.id}> · Author DM: ${delivery}`,
  );
  await reply(
    i,
    `${item.status === 'approved' ? 'Approved' : 'Rejected'}. DM: ${delivery}.${rendered ? '' : ' The card refresh is pending; its controls cannot review this submission again.'}`,
  );
}
