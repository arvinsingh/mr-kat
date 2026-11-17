import type { Module } from '../types.js';
import { PermissionFlagsBits as P } from 'discord.js';
import { enabled, requirePermission } from '../permissions.js';
import { reply, embed } from '../ui.js';
export const statistics: Module = {
  commands: {
    stats: async (app, i) => {
      enabled(app, i.guildId, 'stats');
      await requirePermission(app, i, P.ModerateMembers);
      const stats = app.store.stats(i.guildId);
      await reply(i, {
        embeds: [
          embed(
            'Server statistics · last 30 days',
            `Members now: ${i.guild.memberCount}\nJoins: ${stats.joins ?? 0}\nLeaves: ${stats.leaves ?? 0}\nMessages observed: ${stats.messages ?? 0}\nConnected voice hours: ${((stats.voiceSeconds ?? 0) / 3600).toFixed(1)}\nModeration actions: ${stats.moderation ?? 0}\n\nCounts start when this bot is connected. Excluded channels are omitted; voice time does not measure speaking.`,
          ),
        ],
      });
    },
    activity: async (app, i) => {
      enabled(app, i.guildId, 'stats');
      await requirePermission(app, i, P.ModerateMembers);
      const days = i.options.getInteger('days') ?? 30;
      const cutoff = Date.now() - days * 86400000;
      const entries = app.store.inactiveMembers(i.guildId, cutoff);
      await reply(
        i,
        `Members with previously observed activity older than ${days} days:\n${entries.map((e) => `<@${e.key}> · <t:${Math.floor(e.data.last / 1000)}:R>`).join('\n') || 'None in the retained observations.'}\nThis is not proof of inactivity; unobserved members are omitted.`,
      );
    },
  },
};
