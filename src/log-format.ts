import type { Message, MessageCreateOptions } from 'discord.js';
import type { LogKind } from './config.js';
import type { AuditOptions } from './types.js';
import { auditPages, auditEmbed, noMentions } from './ui.js';
import { safeMentions } from './util.js';

// User text cannot introduce a layout divider into a before/after record.
export const logText = (value: unknown) =>
  safeMentions(value).replace(/(^|\n)---(?=\r?\n|$)/g, '$1\\-\\-\\-');

export function logPayloads(
  kind: LogKind,
  title: string,
  description: string,
  options: AuditOptions = {},
): MessageCreateOptions[] {
  const chunks = auditPages(kind, title, description).map((page) => page.data.description!);
  const at = options.at ?? Date.now();
  const profile = options.profile ?? { name: 'Bot' };
  return chunks.map((chunk, index) => {
    const page = auditEmbed(
      kind,
      chunks.length > 1 ? `${title.slice(0, 220)} · ${index + 1}/${chunks.length}` : title,
      chunk,
    ).setAuthor({
      name: profile.name,
      ...(profile.iconURL ? { iconURL: profile.iconURL } : {}),
      ...(profile.id ? { url: `https://discord.com/users/${profile.id}` } : {}),
    });
    const heading = `${page.data.title}${profile.mention && profile.id ? ` · <@${profile.id}>` : ''}`;
    const body = options.dividers ? chunk.replaceAll('\n---\n', '\n──────────\n') : chunk;
    if (kind === 'voice') page.setDescription(body);
    // Native references stay unmasked and outside the bold action text.
    else
      page
        .setTitle(null)
        .setDescription(
          `**${heading}**${options.reference ? ' · ' + options.reference : ''}\n\n${body}`,
        );
    page.setTimestamp(at);
    if (options.footer) page.setFooter({ text: options.footer.slice(0, 200) });
    if (!index && options.image) page.setImage(options.image);
    return {
      embeds: [page],
      allowedMentions: noMentions,
      ...(!index && options.controls?.length ? { components: options.controls } : {}),
      ...(!index && options.files?.length ? { files: options.files } : {}),
    };
  });
}

// Staff inboxes and live incident cards share event-log presentation without
// redirecting their contents to another destination or retrying sends.
export async function sendLog(
  target: { send(options: MessageCreateOptions): Promise<Message> },
  kind: LogKind,
  title: string,
  description: string,
  options: AuditOptions = {},
) {
  let first: Message | undefined;
  for (const payload of logPayloads(kind, title, description, options)) {
    const message = await target.send(payload);
    first ??= message;
  }
  return first!;
}
