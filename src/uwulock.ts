import {
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  MessageType,
  PermissionFlagsBits as P,
  type GuildTextBasedChannel,
  type Guild,
  type Message,
  type Webhook,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App } from './types.js';
import type { GuildConfig } from './config.js';
import { checkHierarchy } from './permissions.js';
import { transformText } from './text-effects.js';
import { assert, safeMentions } from './util.js';
import { noMentions } from './ui.js';

export interface UwuLock {
  token: string;
  author: string;
  actor: string;
  channel: string;
  expires: number;
}
interface SourceReceipt {
  state: 'preparing' | 'sending' | 'deleting' | 'complete' | 'failed' | 'uncertain';
  replacement?: string;
  channel?: string;
  author?: string;
  at?: number;
}
export interface UwuPost {
  author: string;
  channel: string;
  parent: string;
  webhook: string;
  source: string;
  input: string;
  revision: string;
  bodyAttachment?: string;
  prefix?: string;
}
const busy = new WeakMap<App, Set<string>>();
const hooks = new WeakMap<App, Map<string, { hook: Webhook; until: number }>>();
const hookPending = new WeakMap<App, Map<string, Promise<Webhook>>>();
const MAX_FILES = 10 * 1024 * 1024;
const stopping = new WeakSet<App>();
export async function stopUwuReplacements(app: App) {
  stopping.add(app);
  while (busy.get(app)?.size) await new Promise((resolve) => setTimeout(resolve, 50));
}
export const lockKey = (channel: string, author: string) => `${channel}:${author}`;
export const uwuScope = (channel: string) => (channel === '*' ? 'server-wide' : `in <#${channel}>`);
export function findUwuLock(app: App, channel: string, author: string) {
  for (const scope of [channel, '*']) {
    const lock = app.store.get<UwuLock>(app.guildId, 'uwuLock', lockKey(scope, author));
    if (lock && lock.expires > Date.now()) return lock;
  }
  return undefined;
}
export function activeLocks(app: App) {
  return app.store
    .entries<UwuLock>(app.guildId, 'uwuLock', 1000)
    .filter(({ data }) => data.expires > Date.now());
}
export function isUwuDeletion(app: App, messageId: string) {
  const receipt = app.store.get<SourceReceipt>(app.guildId, 'uwuSource', messageId);
  return (
    (receipt?.state === 'deleting' && (receipt.at ?? 0) > Date.now() - 60000) ||
    receipt?.state === 'complete'
  );
}
export function uwuDeliveryIssues(app: App) {
  return app.store
    .entries<SourceReceipt>(app.guildId, 'uwuSource', 10000)
    .filter(
      ({ data, updated }) =>
        data.state === 'uncertain' ||
        (['preparing', 'sending', 'deleting'].includes(data.state) && updated < Date.now() - 60000),
    );
}
export function uwuBlockReason(
  app: App,
  channel: GuildTextBasedChannel,
  cfg: GuildConfig,
): string | undefined {
  if (!cfg.modules.community)
    return 'The community module is disabled. Ask the owner to enable it with /config module.';
  if (!cfg.uwuLock.enabled)
    return 'UwU Lock is disabled in configuration. Ask the owner to enable uwuLock.enabled with /config set.';
  const parent = channel.isThread() ? channel.parent : channel;
  if (!parent) return 'The parent channel is unavailable. Check the bot’s View Channel permission.';
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(parent.type))
    return 'UwU Lock needs a text or announcement channel, or a public thread in one. Voice chats and forum posts are unsupported.';
  if (channel.isThread()) {
    if (channel.type === ChannelType.PrivateThread)
      return 'UwU Lock is unavailable in private threads. Choose a regular text channel or public thread.';
    if (channel.archived || channel.locked)
      return 'This thread is archived or locked. Reopen it before using UwU Lock.';
  }
  const ids = [channel.id, parent.id];
  if (ids.some((id) => cfg.excludedChannels.includes(id)))
    return 'This channel or its parent is listed in excludedChannels. Ask the owner to review that setting, or choose another channel.';
  const log = Object.entries(cfg.logs).find(([, id]) => id && ids.includes(id));
  if (log)
    return `This is configured as the ${log[0]} log channel. UwU Lock cannot replace messages in log destinations; choose a chat channel.`;
  const destinations: [string, string | undefined][] = [
    ['confession publication', cfg.confessions.channel],
    ['confession review', cfg.confessions.reviewChannel],
    ['starboard', cfg.starboard.channel],
    ['heartbeat', cfg.heartbeat.channel],
    ['rules', cfg.rulesChannel],
    ['self-role selection', cfg.rolesSource === 'channel' ? cfg.rolesChannel : undefined],
  ];
  const destination = destinations.find(([, id]) => id && ids.includes(id));
  if (destination)
    return `This is configured as the ${destination[0]} channel. Choose a regular chat channel for UwU Lock.`;
  if (
    (cfg.ticketCategory && parent.parentId === cfg.ticketCategory) ||
    ids.some((id) => app.store.get(app.guildId, 'ticket', id))
  )
    return 'This is a support ticket or belongs to the configured ticket category. Use a chat channel outside the ticket system.';
  if (ids.some((id) => app.store.get(app.guildId, 'confessionThread', id)))
    return 'This is an anonymous confession discussion. UwU Lock is unavailable here.';
  if (cfg.uwuLock.channels.length && !ids.some((id) => cfg.uwuLock.channels.includes(id)))
    return 'This channel is not on the uwuLock.channels allowlist. Ask the owner to add its channel ID or choose an allowed channel.';
  return undefined;
}
export function uwuEligible(app: App, channel: GuildTextBasedChannel, cfg: GuildConfig) {
  return !uwuBlockReason(app, channel, cfg);
}
export async function lockGuildAuthority(app: App, guild: Guild, lock: UwuLock) {
  let cfg = app.store.config(app.guildId);
  assert(
    cfg.modules.community,
    'The community module is disabled. Ask the owner to enable it with /config module.',
  );
  assert(
    cfg.uwuLock.enabled,
    'UwU Lock is disabled in configuration. Ask the owner to enable uwuLock.enabled with /config set.',
  );
  const [actor, target, me] = await Promise.all([
    guild.members.fetch(lock.actor),
    guild.members.fetch(lock.author),
    guild.members.fetchMe(),
  ]);
  cfg = app.store.config(app.guildId);
  assert(
    cfg.modules.community && cfg.uwuLock.enabled,
    'UwU Lock was disabled while this action was being checked.',
  );
  if (lock.channel === '*')
    assert(
      actor.permissions.has(P.ManageMessages),
      'Server-wide locks require the applying staff member to have Manage Messages in the server.',
    );
  assert(
    actor.id === guild.ownerId ||
      !cfg.staffRoles.length ||
      cfg.staffRoles.some((id) => actor.roles.cache.has(id)),
    'Staff allowlist check failed.',
  );
  assert(
    !target.user.bot && !target.permissions.has(P.Administrator),
    'Bots and administrators cannot be UwU locked.',
  );
  checkHierarchy(actor, target, me, guild.ownerId, cfg.protectedRoles);
  return { actor, target, me };
}
export async function lockAuthority(app: App, channel: GuildTextBasedChannel, lock: UwuLock) {
  const blocked = uwuBlockReason(app, channel, app.store.config(app.guildId));
  assert(!blocked, blocked ?? 'UwU Lock is unavailable here.');
  const { actor, target, me } = await lockGuildAuthority(app, channel.guild, lock);
  const currentBlock = uwuBlockReason(app, channel, app.store.config(app.guildId));
  assert(!currentBlock, currentBlock ?? 'UwU Lock is unavailable here.');
  assert(
    channel.permissionsFor(actor)?.has([P.ViewChannel, P.ManageMessages]),
    'Staff need View Channel and Manage Messages in this channel.',
  );
  assert(
    channel
      .permissionsFor(target)
      ?.has([P.ViewChannel, channel.isThread() ? P.SendMessagesInThreads : P.SendMessages]),
    'The member cannot post here.',
  );
  assert(
    channel
      .permissionsFor(me)
      ?.has([
        P.ViewChannel,
        P.ReadMessageHistory,
        P.ManageMessages,
        P.ManageWebhooks,
        P.AttachFiles,
        channel.isThread() ? P.SendMessagesInThreads : P.SendMessages,
      ]),
    'The bot needs View Channel, Read Message History, Send Messages, Manage Messages, Manage Webhooks and Attach Files here.',
  );
  return { actor, target, me };
}
export async function uwuWebhook(
  app: App,
  channel: GuildTextBasedChannel,
  expected?: string,
): Promise<Webhook> {
  const parent = channel.isThread() ? channel.parent : channel;
  assert(
    parent && 'fetchWebhooks' in parent && 'createWebhook' in parent,
    'This channel cannot use UwU webhooks.',
  );
  let cache = hooks.get(app);
  if (!cache) hooks.set(app, (cache = new Map()));
  const cached = cache.get(parent.id);
  if (cached && cached.until > Date.now() && (!expected || cached.hook.id === expected))
    return cached.hook;
  let pending = hookPending.get(app);
  if (!pending) hookPending.set(app, (pending = new Map()));
  const key = `${parent.id}:${expected ?? 'create'}`;
  const previous = pending.get(key);
  if (previous) return previous;
  const work = (async () => {
    const existing = await parent.fetchWebhooks();
    let hook = existing.find(
      (item) =>
        item.owner?.id === app.client.user!.id &&
        (expected ? item.id === expected : item.name === 'mr-kat UwU Lock'),
    );
    assert(
      !expected || hook,
      'The original UwU webhook was removed. Ask staff to delete the post.',
    );
    if (!hook)
      hook = await parent.createWebhook({
        name: 'mr-kat UwU Lock',
        reason: 'Timed UwU Lock text replacement',
      });
    assert(hook.token, 'The bot cannot access this webhook.');
    cache.set(parent.id, { hook, until: Date.now() + 900000 });
    return hook;
  })();
  pending.set(key, work);
  try {
    return await work;
  } finally {
    pending.delete(key);
  }
}
async function attachmentBytes(url: string, maximum: number, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  assert(response.ok && response.body, 'An attachment could not be downloaded.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      assert(size <= maximum, 'Attachments exceed the safe forwarding limit.');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}
export function uwuBody(input: string, source: string, prefix = '') {
  const converted = transformText('uwuify', input, { exclamations: true });
  const full = prefix + converted;
  return full.length <= 2000
    ? { content: full, files: [] as AttachmentBuilder[] }
    : {
        content: `${prefix}Full UwU text attached.`,
        files: [
          new AttachmentBuilder(Buffer.from(full, 'utf8'), { name: `uwulock-${source}.txt` }),
        ],
      };
}
function fingerprint(message: Message) {
  return JSON.stringify([
    message.content,
    [...message.attachments.values()]
      .map((a) => [a.id, a.name, a.description])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}
function unchanged(before: string, after: Message) {
  return before === fingerprint(after) && !after.pinned && !after.hasThread;
}
async function audit(app: App, title: string, text: string, kind: 'admin' | 'messages' = 'admin') {
  await app.audit(app.guildId, kind, title, text).catch(() => undefined);
}
export async function uwuMessage(app: App, message: Message): Promise<boolean> {
  if (stopping.has(app)) return false;
  if (
    message.guildId !== app.guildId ||
    !message.guild ||
    message.author.bot ||
    message.webhookId ||
    message.system ||
    ![MessageType.Default, MessageType.Reply].includes(message.type) ||
    !message.content.trim() ||
    message.content.length > 4000 ||
    message.pinned ||
    message.hasThread ||
    message.stickers.size ||
    message.poll ||
    message.messageSnapshots.size ||
    message.content.startsWith('!')
  )
    return false;
  const lock = findUwuLock(app, message.channelId, message.author.id);
  if (
    !lock ||
    lock.expires <= Date.now() ||
    !uwuEligible(app, message.channel as GuildTextBasedChannel, app.store.config(app.guildId))
  )
    return false;
  if (lock.channel === '*') {
    // A global lock can encounter channels where the target, staff or bot lack
    // access. Skip those without creating an error log for every message.
    try {
      await lockAuthority(app, message.channel as GuildTextBasedChannel, lock);
    } catch {
      return false;
    }
    if (stopping.has(app)) return false;
  }
  const key = lockKey(lock.channel, lock.author);
  if (app.store.get(app.guildId, 'uwuSource', message.id)) return true;
  let running = busy.get(app);
  if (!running) busy.set(app, (running = new Set()));
  if (running.has(message.id) || running.size >= 25) return false;
  running.add(message.id);
  // Force fetches update discord.js cached Message objects in place. Keep a value baseline.
  const baseline = fingerprint(message),
    input = message.content;
  app.store.put(app.guildId, 'uwuSource', message.id, {
    state: 'preparing',
    channel: message.channelId,
    author: message.author.id,
  });
  let stage = 'preparing';
  const receipt = (state: SourceReceipt['state'], replacement?: string) => {
    stage = state;
    app.store.put(app.guildId, 'uwuSource', message.id, {
      state,
      replacement,
      channel: message.channelId,
      author: message.author.id,
      at: Date.now(),
    });
  };
  try {
    await lockAuthority(app, message.channel as GuildTextBasedChannel, lock);
    const ref = message.reference?.messageId;
    const prefix = ref
      ? `↪ https://discord.com/channels/${app.guildId}/${message.reference?.channelId ?? message.channelId}/${ref}\n`
      : '';
    const body = uwuBody(input, message.id, prefix);
    const displayed =
      body.files.length && Buffer.isBuffer(body.files[0]!.attachment)
        ? body.files[0]!.attachment.toString('utf8')
        : body.content;
    assert(
      message.attachments.size + body.files.length <= 10,
      'Too many attachments to forward safely.',
    );
    let remaining = MAX_FILES;
    const downloadDeadline = AbortSignal.timeout(15000);
    for (const file of message.attachments.values()) {
      assert(file.size <= remaining, 'Attachments exceed the 10 MiB forwarding limit.');
      const bytes = await attachmentBytes(file.url, remaining, downloadDeadline);
      remaining -= bytes.length;
      const name =
        file.spoiler && !file.name.startsWith('SPOILER_') ? `SPOILER_${file.name}` : file.name;
      const builder = new AttachmentBuilder(bytes, { name });
      if (file.description) builder.setDescription(file.description);
      body.files.push(builder);
    }
    const hook = await uwuWebhook(app, message.channel as GuildTextBasedChannel);
    const fresh = await message.channel.messages.fetch({ message: message.id, force: true });
    if (!unchanged(baseline, fresh)) {
      receipt('failed');
      return false;
    }
    await lockAuthority(app, message.channel as GuildTextBasedChannel, lock);
    const current = app.store.get<UwuLock>(app.guildId, 'uwuLock', key);
    if (current?.token !== lock.token || current.expires <= Date.now()) {
      receipt('failed');
      return false;
    }
    receipt('sending');
    const sent = await hook.send({
      ...body,
      username: message.member?.displayName ?? message.author.username,
      avatarURL: message.author.displayAvatarURL(),
      allowedMentions: noMentions,
      flags: MessageFlags.SuppressEmbeds,
      ...(message.channel.isThread() ? { threadId: message.channelId } : {}),
    });
    const post: UwuPost = {
      author: message.author.id,
      channel: message.channelId,
      parent: message.channel.isThread() ? message.channel.parentId! : message.channelId,
      webhook: hook.id,
      source: message.id,
      input,
      prefix,
      revision: randomUUID(),
      bodyAttachment: sent.attachments.find((a) => a.name === `uwulock-${message.id}.txt`)?.id,
    };
    app.store.put(app.guildId, 'uwuPost', sent.id, post);
    receipt('sending', sent.id);
    let deletionAttempted = false;
    try {
      const latest = await message.channel.messages.fetch({ message: message.id, force: true });
      const valid = app.store.get<UwuLock>(app.guildId, 'uwuLock', key);
      assert(
        unchanged(baseline, latest) && valid?.token === lock.token && valid.expires > Date.now(),
        'The source or lock changed during conversion.',
      );
      await lockAuthority(app, message.channel as GuildTextBasedChannel, lock);
      receipt('deleting', sent.id);
      deletionAttempted = true;
      await latest.delete();
    } catch {
      // Never retry a deletion after a transport error. Check which copy survived.
      const original = await message.channel.messages
        .fetch({ message: message.id, force: true })
        .then(
          () => 'present',
          (error: { code?: number }) => (error.code === 10008 ? 'missing' : 'unknown'),
        );
      if (original === 'present' || (original === 'missing' && !deletionAttempted)) {
        try {
          await hook.deleteMessage(
            sent.id,
            message.channel.isThread() ? message.channelId : undefined,
          );
          app.store.delete(app.guildId, 'uwuPost', sent.id);
          receipt('failed');
        } catch {
          receipt('uncertain', sent.id);
        }
        await audit(
          app,
          'UwU conversion incomplete',
          `Member <@${message.author.id}> in <#${message.channelId}>. ${original === 'present' ? 'Original retained.' : 'The original was deleted externally; its replacement was removed where possible.'} Review replacement ${sent.id} before retrying.`,
        );
        return true;
      }
      if (original === 'unknown') {
        receipt('uncertain', sent.id);
        await audit(
          app,
          'UwU delivery needs review',
          `Original ${message.id}, replacement ${sent.id} in <#${message.channelId}>. Delivery/deletion could not be confirmed; no automatic retry.`,
        );
        return true;
      }
    }
    receipt('complete', sent.id);
    const stats =
      app.store.get<{ count: number }>(app.guildId, 'uwuStats', message.author.id)?.count ?? 0;
    app.store.put(app.guildId, 'uwuStats', message.author.id, { count: stats + 1 });
    app.store.forgetMessage(message.id);
    await audit(
      app,
      'Message transformed · UwU Lock',
      `Author: <@${message.author.id}> (${message.author.id})\nChannel: <#${message.channelId}>\nLock applied by: <@${lock.actor}>\nOriginal ID: ${message.id}\nReplacement: ${sent.url}\nOriginal text: ${safeMentions(input)}\nUwU text: ${safeMentions(displayed)}${message.attachments.size ? `\nForwarded attachments: ${[...message.attachments.values()].map((a) => `${safeMentions(a.name)} · ${a.url}`).join('\n')}` : ''}`,
      'messages',
    );
    return true;
  } catch {
    receipt(stage === 'sending' || stage === 'deleting' ? 'uncertain' : 'failed');
    await audit(
      app,
      'UwU conversion could not finish',
      `Member <@${message.author.id}> in <#${message.channelId}> · Original ID ${message.id}. No automatic retry. Check permissions, webhook access and attachments. The original is kept unless a confirmed replacement was already sent.`,
    );
    return true;
  } finally {
    running.delete(message.id);
  }
}

const lastExpiry = new WeakMap<App, number>();
export async function expireUwuLocks(app: App) {
  if ((lastExpiry.get(app) ?? 0) > Date.now() - 30000) return;
  lastExpiry.set(app, Date.now());
  for (const { key, data } of app.store.entries<UwuLock>(app.guildId, 'uwuLock', 1000)) {
    if (data.expires > Date.now()) continue;
    app.store.delete(app.guildId, 'uwuLock', key);
    await audit(
      app,
      'UwU lock expired',
      `<@${data.author}> ${uwuScope(data.channel)} is unlocked. Applied by <@${data.actor}>.`,
    );
  }
}
