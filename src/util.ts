import { escapeMarkdown } from 'discord.js';
export class UserError extends Error {}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new UserError(message);
}
export function duration(text: string, max = 365 * 86400000): number {
  const match = /^(\d+)(s|m|h|d|w)$/i.exec(text.trim());
  assert(match, 'Use a duration such as 30m, 2h, 7d, or 1w.');
  const factors: Record<string, number> = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000,
  };
  const value = Number(match[1]) * factors[match[2]!.toLowerCase()]!;
  assert(
    Number.isSafeInteger(value) && value >= 10000 && value <= max,
    `Duration must be at least 10 seconds and no more than ${Math.floor(max / 86400000)} days.`,
  );
  return value;
}
export const safe = (text: unknown, limit = 1800): string =>
  escapeMarkdown(String(text)).replace(/@/g, '@\u200b').slice(0, limit);
// Preserve Discord's actual references, while neutralizing plain @everyone/@here.
// All callers that send these strings must also use allowedMentions: noMentions.
export function safeMentions(text: unknown): string {
  return String(text)
    .split(/(<(?:@!?|@&|#)\d{17,22}>)/g)
    .map((part) => (/^<(?:@!?|@&|#)\d{17,22}>$/.test(part) ? part : safe(part, Infinity)))
    .join('');
}
export function errorText(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  if (process.env.DISCORD_TOKEN)
    message = message.split(process.env.DISCORD_TOKEN).join('[redacted]');
  // Redact token-shaped authorization values without corrupting ordinary
  // diagnostics such as "the bot is missing Manage Roles".
  return message.replace(/\bBot\s+[\w.-]{30,}/gi, 'Bot [redacted]').slice(0, 1000);
}
export function logError(context: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: 'error',
      context,
      message: errorText(error),
      time: new Date().toISOString(),
    }),
  );
}
export function parseIds(text: string): string[] {
  const ids = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((s) => s.replace(/[<@&#>]/g, '')),
    ),
  ];
  assert(
    ids.length > 0 && ids.length <= 25 && ids.every((s) => /^\d{17,22}$/.test(s)),
    'Supply 1–25 Discord IDs or mentions separated by commas.',
  );
  return ids;
}
export function renderTemplate(
  template: string,
  user: { id: string; username: string },
  server: string,
): string {
  return template
    .replaceAll('{user}', `<@${user.id}>`)
    .replaceAll('{name}', safe(user.username, 100))
    .replaceAll('{server}', safe(server, 100));
}
