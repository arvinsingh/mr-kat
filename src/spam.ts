import type { GuildConfig } from './config.js';
export interface SpamMessage {
  id: string;
  user: string;
  channel: string;
  content: string;
  mentions: number;
  attachments: number;
  time: number;
}
export class SpamDetector {
  private windows = new Map<string, SpamMessage[]>();
  private alerts = new Map<string, number>();
  check(guild: string, message: SpamMessage, settings: GuildConfig['automod']): string | undefined {
    const key = `${guild}:${message.user}`,
      cutoff = message.time - settings.windowSeconds * 1000;
    const window = (this.windows.get(key) ?? []).filter((m) => m.time > cutoff);
    window.push(message);
    this.windows.set(key, window.slice(-100));
    if (this.windows.size > 1000)
      for (const [k, v] of this.windows)
        if (!v.length || v[v.length - 1]!.time < message.time - 60000) this.windows.delete(k);
    if (this.windows.size > 2000) this.windows.delete(this.windows.keys().next().value!);
    if (this.alerts.size > 2000)
      for (const [k, t] of this.alerts) if (t < message.time - 60000) this.alerts.delete(k);
    if ((this.alerts.get(key) ?? 0) > message.time - 15000) return;
    const normalized = message.content.toLowerCase().replace(/\s+/g, ' ').trim();
    let reason: string | undefined;
    if (window.length >= settings.messageLimit) reason = 'message flood';
    else if (
      normalized &&
      window.filter((m) => m.content.toLowerCase().replace(/\s+/g, ' ').trim() === normalized)
        .length >= settings.repeatLimit
    )
      reason = 'repeated messages';
    else if (window.reduce((sum, m) => sum + m.mentions, 0) >= settings.mentionLimit)
      reason = 'mention flood';
    else if (window.reduce((sum, m) => sum + m.attachments, 0) >= settings.attachmentLimit)
      reason = 'attachment flood';
    else if (
      settings.blockInvites &&
      /(?:discord\.gg|discord(?:app)?\.com\/invite)\//i.test(message.content)
    )
      reason = 'blocked invite';
    else {
      const domains = [...message.content.matchAll(/https?:\/\/([^\s/<>]+)/gi)].map((match) => {
        try {
          return new URL(`https://${match[1]}`).hostname.toLowerCase();
        } catch {
          return '';
        }
      });
      if (
        domains.some((domain) =>
          settings.blockedDomains.some(
            (blocked) => domain === blocked || domain.endsWith(`.${blocked}`),
          ),
        )
      )
        reason = 'blocked domain';
    }
    if (reason) this.alerts.set(key, message.time);
    return reason;
  }
}
