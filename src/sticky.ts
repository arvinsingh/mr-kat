import type { Message } from 'discord.js';
import type { App } from './types.js';
import { textChannel } from './discord.js';
import { sendModern } from './presentation.js';
import { noMentions } from './ui.js';
import { logError } from './util.js';
import { randomUUID } from 'node:crypto';

export interface Sticky {
  text: string;
  last: number;
  message?: string;
  nonce?: string;
  due?: number;
  delay?: number;
  trigger?: string;
}
const busy = new WeakMap<App, Set<string>>();

function updateDelay(sticky: Sticky, delay: number) {
  if (!sticky.due || sticky.delay === delay) return false;
  // Older two-minute schedules did not record their delay. Preserve the last activity time.
  sticky.due += delay - (sticky.delay ?? 120000);
  sticky.delay = delay;
  return true;
}

// Persist the deadline rather than holding an event or a timer for each channel.
export async function refreshSticky(app: App, message: Message) {
  if (!message.guild || message.guild.id !== app.guildId) return;
  const cfg = app.store.config(message.guild.id);
  if (!cfg.modules.messages || cfg.excludedChannels.includes(message.channelId)) return;
  const sticky = app.store.get<Sticky>(message.guild.id, 'sticky', message.channelId);
  const ownPost = message.author.id === app.client.user!.id;
  if (
    !sticky ||
    sticky.message === message.id ||
    sticky.trigger === message.id ||
    (ownPost &&
      message.nonce &&
      (String(message.nonce) === sticky.nonce ||
        app.store.get(message.guild.id, 'stickyPost', String(message.nonce))))
  )
    return;
  sticky.delay = cfg.stickyDelayMinutes * 60000;
  sticky.due = Date.now() + sticky.delay;
  sticky.trigger = message.id;
  app.store.put(message.guild.id, 'sticky', message.channelId, sticky);
}

export async function stickyTick(app: App, now = Date.now()) {
  let active = busy.get(app);
  if (!active) busy.set(app, (active = new Set()));
  for (const entry of app.store.entries<Sticky>(app.guildId, 'sticky')) {
    const cfg = app.store.config(app.guildId);
    if (updateDelay(entry.data, cfg.stickyDelayMinutes * 60000))
      app.store.put(app.guildId, 'sticky', entry.key, entry.data);
    if (!entry.data.due || entry.data.due > now || active.has(entry.key)) continue;
    if (!cfg.modules.messages || cfg.excludedChannels.includes(entry.key)) continue;
    active.add(entry.key);
    try {
      const channel = await textChannel(app, app.guildId, entry.key);
      const sticky = app.store.get<Sticky>(app.guildId, 'sticky', entry.key);
      // A message or a settings change during the channel lookup starts a new wait.
      if (!sticky || sticky.due !== entry.data.due || sticky.trigger !== entry.data.trigger)
        continue;
      const currentConfig = app.store.config(app.guildId);
      if (updateDelay(sticky, currentConfig.stickyDelayMinutes * 60000))
        app.store.put(app.guildId, 'sticky', entry.key, sticky);
      if (
        !currentConfig.modules.messages ||
        currentConfig.excludedChannels.includes(entry.key) ||
        sticky.due! > now
      )
        continue;
      const old = sticky.message;
      sticky.due = undefined;
      sticky.last = now;
      sticky.nonce = randomUUID().replaceAll('-', '').slice(0, 24);
      app.store.put(app.guildId, 'stickyPost', sticky.nonce, { channel: entry.key });
      app.store.put(app.guildId, 'sticky', entry.key, sticky);
      const posted = await sendModern(channel, {
        content: sticky.text,
        nonce: sticky.nonce,
        enforceNonce: true,
        allowedMentions: noMentions,
      });
      const current = app.store.get<Sticky>(app.guildId, 'sticky', entry.key);
      if (current?.nonce === sticky.nonce) {
        // Preserve any new deadline scheduled while the send was in flight.
        current.message = posted.id;
        app.store.put(app.guildId, 'sticky', entry.key, current);
      } else await posted.delete().catch(() => undefined);
      if (old) {
        const previous = await channel.messages.fetch(old).catch(() => null);
        if (previous?.author.id === app.client.user!.id) await previous.delete();
      }
    } catch (error) {
      // An uncertain send is not replayed automatically. A later message can schedule a new refresh.
      const current = app.store.get<Sticky>(app.guildId, 'sticky', entry.key);
      if (current?.due === entry.data.due && current.trigger === entry.data.trigger) {
        current.due = undefined;
        app.store.put(app.guildId, 'sticky', entry.key, current);
      }
      logError('sticky refresh', error);
    } finally {
      active.delete(entry.key);
    }
  }
}
