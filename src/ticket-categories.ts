import {
  ChannelType,
  PermissionFlagsBits as P,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import type { App } from './types.js';
import { missingChannel } from './discord.js';
import { assert } from './util.js';

const queues = new WeakMap<App, Map<string, Promise<unknown>>>();

// Creation and cleanup share a guild lock so an empty-category check cannot race a new ticket.
export async function withTicketCategoryLock<T>(app: App, guild: Guild, work: () => Promise<T>) {
  let queue = queues.get(app);
  if (!queue) queues.set(app, (queue = new Map()));
  const previous = queue.get(guild.id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  queue.set(guild.id, current);
  try {
    return await current;
  } finally {
    if (queue.get(guild.id) === current) queue.delete(guild.id);
  }
}

function remember(app: App, guild: Guild, id: string) {
  app.store.put(guild.id, 'ticketCategory', id, { managed: true });
  const cfg = app.store.config(guild.id);
  if (cfg.ticketCategory !== id) {
    cfg.ticketCategory = id;
    app.store.setConfig(guild.id, cfg, app.client.user!.id);
  }
}

function forget(app: App, guild: Guild, id: string) {
  app.store.delete(guild.id, 'ticketCategory', id);
  const cfg = app.store.config(guild.id);
  if (cfg.ticketCategory === id) {
    delete cfg.ticketCategory;
    app.store.setConfig(guild.id, cfg, app.client.user!.id);
  }
}

// Call inside withTicketCategoryLock, holding it until the new ticket is recorded.
export async function ensureTicketCategory(app: App, guild: Guild) {
  const cfg = app.store.config(guild.id);
  const selected = cfg.ticketCategory
    ? await guild.channels.fetch(cfg.ticketCategory).catch(missingChannel)
    : null;
  assert(!selected || selected.type === ChannelType.GuildCategory, 'Ticket category is invalid.');
  if (selected) {
    remember(app, guild, selected.id);
    return selected;
  }
  if (cfg.ticketCategory) forget(app, guild, cfg.ticketCategory);
  const channels = await guild.channels.fetch();
  let category = channels.find(
    (channel) => channel?.type === ChannelType.GuildCategory && channel.name === 'Support Tickets',
  );
  if (!category) {
    category = await guild.channels.create({
      name: 'Support Tickets',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.id, deny: [P.ViewChannel] },
        {
          id: app.client.user!.id,
          allow: [
            P.ViewChannel,
            P.ManageChannels,
            P.ManageRoles,
            P.SendMessages,
            P.ReadMessageHistory,
          ],
        },
        ...app.store.config(guild.id).staffRoles.map((id) => ({
          id,
          allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory],
        })),
      ],
      reason: 'Create support ticket category on demand',
    });
  }
  assert(category.type === ChannelType.GuildCategory, 'Ticket category is invalid.');
  remember(app, guild, category.id);
  return category;
}

export async function reconcileTicketCategories(app: App, guild: Guild) {
  await withTicketCategoryLock(app, guild, async () => {
    // A failed lookup must never be interpreted as an empty category or missing ticket.
    const channels = await guild.channels.fetch();
    for (const ticket of app.store.entries(guild.id, 'ticket'))
      if (!channels.has(ticket.key)) app.store.delete(guild.id, 'ticket', ticket.key);

    const cfg = app.store.config(guild.id);
    // Adopt the explicitly configured legacy category; never delete unrelated categories by name.
    if (cfg.ticketCategory)
      app.store.put(guild.id, 'ticketCategory', cfg.ticketCategory, { managed: true });
    for (const entry of app.store.entries(guild.id, 'ticketCategory')) {
      const category = channels.get(entry.key);
      if (!category) {
        forget(app, guild, entry.key);
        continue;
      }
      if (
        category.type !== ChannelType.GuildCategory ||
        cfg.logsCategory === category.id ||
        cfg.voiceCategory === category.id ||
        channels.some((channel) => channel?.parentId === category.id)
      )
        continue;
      // Only a confirmed empty managed category is deleted. Closed ticket channels still count.
      await category.delete('Last support ticket channel deleted');
      forget(app, guild, category.id);
    }
  });
}

export async function ticketChannelDeleted(app: App, channel: GuildBasedChannel) {
  app.store.delete(channel.guild.id, 'ticket', channel.id);
  if (channel.type === ChannelType.GuildCategory) forget(app, channel.guild, channel.id);
  const cfg = app.store.config(channel.guild.id);
  if (cfg.ticketCategory || app.store.entries(channel.guild.id, 'ticketCategory').length)
    await reconcileTicketCategories(app, channel.guild);
}
