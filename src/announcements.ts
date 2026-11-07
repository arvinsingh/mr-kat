import { assert } from './util.js';
import { embed } from './ui.js';

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
  return embed(title, text, 'announcement').setDescription(text);
}

// Discord renders ID-based mentions in an embed description. Text labels alone are not mentions.
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
