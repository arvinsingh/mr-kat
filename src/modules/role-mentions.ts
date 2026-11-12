import { PermissionFlagsBits as P } from 'discord.js';
import type { Module } from '../types.js';
import { owner, requirePermission } from '../permissions.js';
import { assert, parseIds } from '../util.js';
import { destination } from '../discord.js';
import { reply } from '../ui.js';

export const roleMentions: Module = {
  commands: {
    mentionguard: async (app, i) => {
      await requirePermission(app, i, P.ManageGuild);
      const action = i.options.getSubcommand(),
        cfg = app.store.config(i.guildId);
      if (action === 'status') {
        const guard = cfg.roleMentions;
        await reply(
          i,
          `Role mention redirects: ${guard.enabled ? 'enabled' : 'disabled'}. AutoMod module: ${cfg.modules.automod ? 'on' : 'off'}.\nScope: ${guard.channel ? `<#${guard.channel}> and its threads` : 'server-wide across accessible eligible channels'}\nProtected roles: ${guard.roles.map((id) => `<@&${id}>`).join(', ') || 'none'}\nSupport: ${guard.supportChannel ? `<#${guard.supportChannel}>` : '/ticket open'}\nRepeat alert: ${guard.repeatLimit} messages within ${guard.windowSeconds}s, or ${guard.repeatLimit} distinct roles in one message.\nThis guard keeps messages and does not retract delivered notifications. Set protected roles unmentionable and restrict Mention Everyone/All Roles to prevent ordinary role notifications. /automod mentions creates native per-message blocking; it is independent of this redirect guard.`,
        );
        return;
      }
      owner(i);
      if (action === 'disable') cfg.roleMentions.enabled = false;
      else {
        const roles = parseIds(i.options.getString('roles', true));
        for (const id of roles) {
          const role = await i.guild.roles.fetch(id);
          assert(role && role.id !== i.guildId, 'Choose existing server roles, not @everyone.');
        }
        const scope = i.options.getChannel('channel');
        const channel = scope ? await destination(app, i, scope.id) : undefined;
        const support = i.options.getChannel('support_channel');
        const supportChannel = support ? await destination(app, i, support.id) : undefined;
        cfg.roleMentions = {
          ...cfg.roleMentions,
          enabled: true,
          roles,
          channel: channel?.id,
          supportChannel: supportChannel?.id ?? cfg.roleMentions.supportChannel,
          repeatLimit: i.options.getInteger('limit') ?? cfg.roleMentions.repeatLimit,
          windowSeconds: i.options.getInteger('seconds') ?? cfg.roleMentions.windowSeconds,
        };
      }
      app.store.setConfig(i.guildId, cfg, i.user.id);
      await reply(
        i,
        action === 'disable'
          ? 'Role mention redirects disabled.'
          : `Role mention redirects enabled ${cfg.roleMentions.channel ? `in <#${cfg.roleMentions.channel}> and its threads` : 'server-wide'}. Messages are kept. Notification prevention still depends on Discord role permissions or native AutoMod.`,
      );
    },
  },
};
