import { assert } from './util.js';
import { embed } from './ui.js';
import { modernPages, modernEdit, splitDisplayText } from './presentation.js';
import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js';
import type { App } from './types.js';
import { noMentions } from './ui.js';

interface AnnouncementRecord {
  actor: string;
  channel: string;
  root: string;
  pages: string[];
  everyone?: boolean;
}

export function announcementPages(title: string, text: string, everyone = false) {
  const card = announcementEmbed(title, text).toJSON();
  if (everyone) {
    card.title = title.replace(/@(everyone|here)/gi, '@\u200b$1');
    card.description = text.replace(/@(everyone|here)/gi, '@\u200b$1');
  }
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${card.title}`),
  );
  let lines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  const flush = () => {
    const content = lines.join('\n');
    if (content.trim())
      for (const part of splitDisplayText(content))
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(part));
    lines = [];
  };
  for (const line of card.description!.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (
        marker[1]![0] === fence.marker &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined;
    }
    if (!fence && /^\s*---\s*$/.test(line)) {
      flush();
      container.addSeparatorComponents(new SeparatorBuilder());
    } else lines.push(line);
  }
  flush();
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# <t:${Math.floor(Date.parse(card.timestamp!) / 1000)}:f>`,
    ),
  );
  return modernPages({
    ...(everyone ? { content: '@everyone' } : {}),
    components: [container],
    allowedMentions: everyone
      ? { parse: ['everyone' as const], users: [], roles: [], repliedUser: false }
      : noMentions,
  }).map((page, index) => ({
    ...page,
    allowedMentions: index ? noMentions : page.allowedMentions,
  }));
}

export async function publishAnnouncement(
  app: App,
  guild: string,
  actor: string,
  channel: GuildTextBasedChannel,
  title: string,
  text: string,
  options: { everyone?: boolean; nonce?: string } = {},
) {
  const messages: Message[] = [];
  for (const [index, page] of announcementPages(title, text, options.everyone).entries()) {
    const message = await channel.send({
      ...page,
      // Only the first page may ping. Never replay a notification on overflow pages.
      allowedMentions: index ? noMentions : page.allowedMentions,
      ...(options.nonce
        ? {
            nonce: index ? `${options.nonce.slice(0, 18)}-${index}` : options.nonce,
            enforceNonce: true,
          }
        : {}),
    });
    messages.push(message);
    const record: AnnouncementRecord = {
      actor,
      channel: channel.id,
      root: messages[0]!.id,
      pages: messages.map((m) => m.id),
      everyone: options.everyone,
    };
    for (const sent of messages) app.store.put(guild, 'announcement', sent.id, record);
  }
  return messages[0]!;
}

export async function editAnnouncement(
  app: App,
  guild: string,
  channel: GuildTextBasedChannel,
  message: Message,
  title: string,
  text: string,
) {
  const tracked = app.store.get<AnnouncementRecord>(guild, 'announcement', message.id);
  assert(tracked, 'This message is not a tracked announcement.');
  const ids = tracked.pages ?? [message.id];
  const posts = await Promise.all(
    ids.map(async (id) => {
      const post = id === message.id ? message : await channel.messages.fetch(id);
      assert(post.author.id === app.client.user!.id, 'Announcement ownership changed.');
      return post;
    }),
  );
  const pages = announcementPages(title, text, tracked.everyone);
  const kept: Message[] = [];
  for (const [index, page] of pages.entries()) {
    const post = posts[index];
    if (post) {
      await post.edit({ ...modernEdit(page), allowedMentions: noMentions });
      kept.push(post);
    } else kept.push(await channel.send({ ...page, allowedMentions: noMentions }));
  }
  for (const post of posts.slice(pages.length)) {
    await post.delete();
    app.store.delete(guild, 'announcement', post.id);
  }
  const record = { ...tracked, root: kept[0]!.id, pages: kept.map((m) => m.id) };
  for (const post of kept) app.store.put(guild, 'announcement', post.id, record);
}

export function announcementEmbed(title: string, text: string) {
  assert(
    title.trim().length > 0 && title.length <= 256,
    'Use a title between 1 and 256 characters.',
  );
  assert(
    text.trim().length > 0 && text.length <= 4096,
    'The announcement body, including selected tags, must be between 1 and 4096 characters.',
  );
  // Preserve long builder text; the shared embed helper caps ordinary descriptions at 4000.
  return embed(title, text, 'announcement').setColor(null).setDescription(text);
}

// Discord renders ID-based mentions in text components. Text labels alone are not mentions.
export function announcementText(
  text: string,
  references: { user?: string; channel?: string } = {},
): string {
  const additions: string[] = [];
  for (const [placeholder, value, prefix, option] of [
    ['{user}', references.user, '@', 'mention_user'],
    ['{channel}', references.channel, '#', 'mention_channel'],
  ] as const) {
    assert(!text.includes(placeholder) || value, `Select ${option} to use ${placeholder}.`);
    if (!value) continue;
    assert(/^\d{17,22}$/.test(value), 'Invalid announcement reference.');
    const mention = `<${prefix}${value}>`;
    if (text.includes(placeholder)) text = text.replaceAll(placeholder, mention);
    else additions.push(mention);
  }
  return additions.length ? `${text}\n\n${additions.join(' ')}` : text;
}
