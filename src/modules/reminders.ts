import type { Module } from '../types.js';
import { PermissionFlagsBits as P } from 'discord.js';
import { enabled, requirePermission } from '../permissions.js';
import { reply } from '../ui.js';
import { duration, assert } from '../util.js';
import { destination } from '../discord.js';
export const reminders: Module = {
  commands: {
    remind: async (app, i) => {
      enabled(app, i.guildId, 'community');
      assert(
        app.store.pendingReminders(i.guildId, i.user.id) < 20,
        'You already have 20 pending reminders.',
      );
      const delay = duration(i.options.getString('in', true));
      const key = app.store.job(
        i.guildId,
        i.user.id,
        'reminder',
        { text: i.options.getString('text', true), user: i.user.id, server: i.guild.name },
        Date.now() + delay,
      );
      await reply(
        i,
        `Reminder scheduled <t:${Math.floor((Date.now() + delay) / 1000)}:R>. Delivery is by DM; enable DMs for this server. Job: ${key}.`,
      );
    },
    event: async (app, i) => {
      enabled(app, i.guildId, 'community');
      await requirePermission(app, i, P.ManageMessages);
      const channel = await destination(app, i, i.options.getChannel('channel', true).id);
      const delay = duration(i.options.getString('in', true));
      const key = app.store.job(
        i.guildId,
        i.user.id,
        'announce',
        { channel: channel.id, title: 'Event reminder', text: i.options.getString('text', true) },
        Date.now() + delay,
      );
      await reply(i, `Event reminder scheduled. Job: ${key}.`);
    },
  },
};
