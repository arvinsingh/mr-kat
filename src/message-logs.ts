import type { Message, PartialMessage } from 'discord.js';
import type { GuildConfig } from './config.js';
import type { App } from './types.js';
import { safe, safeMentions } from './util.js';
import { isPurgeDeletion } from './purge.js';
import { isUwuDeletion } from './uwulock.js';

type ObservedMessage = Message | PartialMessage;
type Snapshot = ReturnType<App['store']['message']>;

export function messageLogExcludedChannel(cfg: GuildConfig, channel: string): boolean {
  // A partial delete/update can have no author. Excluding every log destination also
  // breaks feedback loops after cache eviction, restarts, and retention cleanup.
  return cfg.excludedChannels.includes(channel) || Object.values(cfg.logs).includes(channel);
}

function ignored(app: App, cfg: GuildConfig, ...messages: ObservedMessage[]): boolean {
  return (
    !cfg.modules.logging ||
    messages.some(
      (message) =>
        messageLogExcludedChannel(cfg, message.channelId) ||
        message.author?.bot ||
        message.author?.id === app.client.user?.id ||
        Boolean(message.webhookId) ||
        Boolean(app.store.get(app.guildId, 'logMessage', message.id)) ||
        isPurgeDeletion(app, message.id),
      // Known purge requests have an explicit pre-deletion batch log with actor/job.
    )
  );
}

function identity(app: App, message: ObservedMessage, previous?: Snapshot, old?: ObservedMessage) {
  const user =
    message.author ??
    old?.author ??
    (previous ? app.client.users.cache.get(previous.author) : undefined);
  const userId = user?.id ?? previous?.author;
  const author = userId
    ? `${user ? `${safe(user.tag || user.username, 120)} · ` : ''}<@${userId}> (ID: ${userId})`
    : 'Unavailable — this message was not cached or previously stored.';
  return `Author: ${author}\nChannel: <#${message.channelId}>\nMessage ID: ${message.id}\nMessage reference: https://discord.com/channels/${app.guildId}/${message.channelId}/${message.id}`;
}

function attachments(message: Message): string {
  // Signed CDN URLs can refresh without a user edit, so compare attachment identity
  // and user-editable metadata, not URLs or embed preview data.
  return JSON.stringify(
    [...message.attachments.values()]
      .map((attachment) => [attachment.id, attachment.name, attachment.description])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

export async function messageUpdated(app: App, old: ObservedMessage, message: ObservedMessage) {
  if (message.guildId !== app.guildId) return;
  const cfg = app.store.config(app.guildId);
  if (ignored(app, cfg, old, message)) return;

  const previous = cfg.snapshotDays > 0 ? app.store.message(message.id) : undefined;
  const before = old.content ?? previous?.content;
  const after = message.content;
  const contentChanged = before !== undefined && after !== null && before !== after;
  const attachmentsChanged =
    !old.partial && !message.partial && attachments(old) !== attachments(message);
  // For an uncached message, a newly supplied edit timestamp is the only edit
  // evidence available. Missing baselines are labelled, rather than invented.
  const uncachedEdit =
    before === undefined &&
    after !== null &&
    message.editedTimestamp !== null &&
    message.editedTimestamp !== old.editedTimestamp;

  // MESSAGE_UPDATE also fires for link previews, pin state and other metadata.
  // An unchanged cached message must not produce a new audit message.
  if (!contentChanged && !attachmentsChanged && !uncachedEdit) return;

  // Persist the new baseline before sending a log, so concurrent/duplicate events
  // cannot read a stale stored version while an audit request is in flight.
  const authorId = message.author?.id ?? old.author?.id ?? previous?.author;
  if (cfg.snapshotDays > 0 && after !== null && authorId)
    app.store.snapshot(app.guildId, message.channelId, message.id, authorId, after);

  await app.audit(
    app.guildId,
    'messages',
    'Message edited',
    `${identity(app, message, previous, old)}\nBefore: ${before === undefined ? 'Unavailable (message was not cached or stored).' : safeMentions(before || '[No text]')}\nAfter: ${after === null ? 'Unavailable.' : safeMentions(after || '[No text]')}${attachmentsChanged ? '\nAttachments changed.' : ''}`,
  );
}

export async function messageDeleted(app: App, message: ObservedMessage) {
  if (message.guildId !== app.guildId) return;
  const cfg = app.store.config(app.guildId);
  const previous = cfg.snapshotDays > 0 ? app.store.message(message.id) : undefined;
  app.store.forgetMessage(message.id);
  if (ignored(app, cfg, message) || isUwuDeletion(app, message.id)) return;

  const content = message.content ?? previous?.content;
  await app.audit(
    app.guildId,
    'messages',
    'Message deleted',
    `${identity(app, message, previous)}\nContent: ${content === undefined ? 'Unavailable (message was not cached or stored).' : safeMentions(content || '[No text]')}`,
  );
}

export async function messagesBulkDeleted(
  app: App,
  messages: Iterable<ObservedMessage>,
  channelId: string,
) {
  const cfg = app.store.config(app.guildId);
  const eligible: { message: ObservedMessage; previous: Snapshot }[] = [];
  for (const message of messages) {
    if (message.guildId !== app.guildId) continue;
    const previous = cfg.snapshotDays > 0 ? app.store.message(message.id) : undefined;
    app.store.forgetMessage(message.id);
    if (!ignored(app, cfg, message) && !isUwuDeletion(app, message.id))
      eligible.push({ message, previous });
  }
  if (!eligible.length) return;
  const details = eligible.map(({ message, previous }) => {
    const authorId = message.author?.id ?? previous?.author;
    const name = message.author
      ? `${safe(message.author.tag || message.author.username, 80)} · `
      : '';
    const content = message.content ?? previous?.content;
    return `Message ID: ${message.id} · Author: ${name}${authorId ? `<@${authorId}> (ID: ${authorId})` : 'unavailable'}\nContent: ${content === undefined ? 'Unavailable (message was not cached or stored).' : safeMentions(content || '[No text]')}`;
  });
  await app.audit(
    app.guildId,
    'messages',
    'Messages bulk deleted',
    `${eligible.length} member messages deleted in <#${channelId}>.\n${details.join('\n\n')}`,
  );
}
