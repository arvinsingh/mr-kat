import { sendModern } from '../presentation.js';
import { PermissionFlagsBits as P } from 'discord.js';
import type { Module } from '../types.js';
import { destination } from '../discord.js';
import { botPermission, enabled } from '../permissions.js';
import { safe } from '../util.js';
import { embed, noMentions, reply } from '../ui.js';

export const easteregg: Module = {
  commands: {
    easteregg: async (app, i) => {
      enabled(app, i.guildId, 'community');
      const channel = await destination(app, i, i.channelId);
      await botPermission(i.guild, P.EmbedLinks, channel);
      await sendModern(channel, {
        embeds: [
          embed(
            'You found an Easter egg! ✨',
            safe(app.store.config(i.guildId).easterEggText, 1800),
            'easteregg',
          ).setFooter({ text: 'Mr. Kat · Curiosity rewarded' }),
        ],
        allowedMentions: noMentions,
      });
      await reply(i, 'Secret revealed. ✨');
    },
  },
};
