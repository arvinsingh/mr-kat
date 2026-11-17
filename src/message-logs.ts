import type { Message, PartialMessage } from 'discord.js';
import type { GuildConfig } from './config.js';
import type { App } from './types.js';
import { safe } from './util.js';
import { logText } from './log-format.js';
import { logProfile } from './log-profile.js';
import { isPurgeDeletion } from './purge.js';
import { isUwuDeletion } from './uwulock.js';

type ObservedMessage = Message | PartialMessage;
type Snapshot = ReturnType<App['store']['message']>;

export function messageLogExcludedChannel(
  cfg: GuildConfig,
  channel: string,
  parent?: string | null,
): boolean {
  // A partial delete/update can have no author. Excluding every log destination also
  // breaks feedback loops after cache eviction, restarts, and retention cleanup.
  return [channel, parent].some(
    (id) => !!id && (cfg.excludedChannels.includes(id) || Object.values(cfg.logs).includes(id)),
  );
}

function ignored(app: App, cfg: GuildConfig, ...messages: ObservedMessage[]): boolean {
  return (
    !cfg.modules.logging ||
    messages.some(
      (message) =>
        messageLogExcludedChannel(cfg, message.channelId, parentChannel(app, message)) ||
        message.author?.bot ||
        message.author?.id === app.client.user?.id ||
        Boolean(message.webhookId) ||
        Boolean(app.store.get(app.guildId, 'logMessage', message.id)) ||
        isPurgeDeletion(app, message.id),
      // Known purge requests have an explicit pre-deletion batch log with actor/job.
    )
  );
}

function parentChannel(app: App, message: ObservedMessage) {
  const channel = message.channel ?? app.client.channels?.cache?.get(message.channelId);
  return channel && 'parentId' in channel ? channel.parentId : undefined;
}
function identity(
  app: App,
  message: ObservedMessage,
  previous?: Snapshot,
  old?: ObservedMessage,
  deleted = false,
) {
  const user = message.author ?? old?.author;
  const userId = user?.id ?? previous?.author;
  return {
    profile: logProfile(app, userId, message.member ?? old?.member, user),
    reference: deleted
      ? `<#${message.channelId}>`
      : `https://discord.com/channels/${app.guildId}/${message.channelId}/${message.id}`,
  };
}
function files(message: ObservedMessage) {
  return [...(message.attachments?.values() ?? [])]
    .map((file) => `[${safe(file.name ?? file.id, 150)}](<${file.url}>)`)
    .join('\n');
}
function attachmentChanges(old: Message, message: Message) {
  const added = [...message.attachments.values()].filter((file) => !old.attachments.has(file.id));
  const removed = [...old.attachments.values()].filter((file) => !message.attachments.has(file.id));
  const changed = [...message.attachments.values()].filter((file) => {
    const previous = old.attachments.get(file.id);
    return previous && (previous.name !== file.name || previous.description !== file.description);
  });
  const list = (items: typeof added) =>
    items.map((file) => `[${safe(file.name ?? file.id, 150)}](<${file.url}>)`).join('\n');
  return [
    '**Attachments changed**',
    added.length ? 'Added:\n' + list(added) : '',
    removed.length ? 'Removed:\n' + list(removed) : '',
    changed.length ? 'Updated:\n' + list(changed) : '',
  ]
    .filter(Boolean)
    .join('\n');
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
    [
      contentChanged || uncachedEdit
        ? `Before: ${before === undefined ? 'Unavailable (message was not cached or stored).' : logText(before || '[No text]')}\n---\nAfter: ${after === null ? 'Unavailable.' : logText(after || '[No text]')}`
        : '',
      attachmentsChanged ? attachmentChanges(old as Message, message as Message) : '',
    ]
      .filter(Boolean)
      .join('\n---\n'),
    {
      ...identity(app, message, previous, old),
      at: message.editedTimestamp ?? Date.now(),
      dividers: true,
      source: { channel: message.channelId, message: message.id, author: authorId },
    },
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
    `Content: ${content === undefined ? 'Unavailable (message was not cached or stored).' : logText(content || '[No text]')}${files(message) ? '\n---\nAttachments:\n' + files(message) : ''}`,
    {
      ...identity(app, message, previous, undefined, true),
      dividers: true,
      source: {
        channel: message.channelId,
        message: message.id,
        author: message.author?.id ?? previous?.author,
      },
    },
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
    const content = message.content ?? previous?.content;
    const name = logProfile(app, authorId, message.member, message.author).name;
    return `**${safe(name, 200)}:** ${content === undefined ? 'Unavailable (message was not cached or stored).' : logText(content || '[No text]')}${files(message) ? '\nAttachments:\n' + files(message) : ''}`;
  });
  await app.audit(
    app.guildId,
    'messages',
    'Messages bulk deleted',
    `${eligible.length} member messages deleted.\n---\n${details.join('\n---\n')}`,
    { dividers: true, reference: `<#${channelId}>` },
  );
}
