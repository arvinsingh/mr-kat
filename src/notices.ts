import type { App } from './types.js';
import { send } from './discord.js';
import { auditPages } from './ui.js';
import { logError } from './util.js';
import type { LogKind } from './config.js';

// A notice failure must not turn a completed moderation action into a failed action.
export async function channelNotice(
  app: App,
  guild: string,
  channel: string,
  kind: LogKind,
  title: string,
  description: string,
): Promise<boolean> {
  try {
    for (const page of auditPages(kind, title, description))
      await send(app, guild, channel, { embeds: [page] });
    return true;
  } catch (error) {
    logError('channel notice', error);
    await app
      .audit(
        guild,
        'admin',
        'Channel notice could not be confirmed',
        `${title}. The operation may already have completed. Check that channel and the bot's Send Messages / Embed Links permissions.`,
        { force: true, reference: `<#${channel}>` },
      )
      .catch((failure) => logError('notice failure log', failure));
    return false;
  }
}
