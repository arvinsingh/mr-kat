import { ChannelType, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import type { Module } from '../types.js';
import { logKinds } from '../config.js';
import { owner, requirePermission, botPermission } from '../permissions.js';
import { assert } from '../util.js';
import { reply } from '../ui.js';
import { logHealthText } from '../logging.js';

const names = {
  moderation: 'moderation-logs',
  messages: 'message-logs',
  members: 'member-logs',
  voice: 'voice-logs',
  admin: 'admin-logs',
  reports: 'report-logs',
  automod: 'automod-logs',
  dm: 'bot-dms',
} as const;
const active = new Set<string>();
export const logs: Module = {
  commands: {
    logs: async (app, i) => {
      if (i.options.getSubcommand() === 'status') {
        await requirePermission(app, i, P.ManageGuild);
        const cfg = app.store.config(i.guildId);
        await reply(
          i,
          logKinds
            .map(
              (kind) =>
                `**${kind}:** ${cfg.logs[kind] ? `<#${cfg.logs[kind]}>` : 'Not configured'}`,
            )
            .join('\n') +
            '\n\n**Delivery health**\n' +
            logHealthText(app),
        );
        return;
      }
      owner(i);
      await requirePermission(app, i, P.ManageGuild);
      await botPermission(i.guild, [P.ManageChannels, P.ManageRoles]);
      assert(!active.has(i.guildId), 'Log setup is already running.');
      active.add(i.guildId);
      try {
        const channels = await i.guild.channels.fetch();
        let cfg = app.store.config(i.guildId);
        assert(
          !cfg.staffRoles.includes(i.guildId),
          'The staff allowlist cannot include @everyone.',
        );
        const selected = i.options.getChannel('category');
        assert(!selected || channels.has(selected.id), 'The selected category is unavailable.');
        let category = selected
          ? channels.get(selected.id)
          : (channels.get(cfg.logsCategory ?? '') ??
            channels.find(
              (c) => c?.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'bot logs',
            ));
        const permissions = [
          { id: i.guildId, deny: [P.ViewChannel] },
          {
            id: app.client.user!.id,
            allow: [
              P.ViewChannel,
              P.SendMessages,
              P.EmbedLinks,
              P.ReadMessageHistory,
              P.AttachFiles,
              P.CreatePublicThreads,
              P.SendMessagesInThreads,
              P.ManageThreads,
            ],
          },
          ...cfg.staffRoles.map((id) => ({
            id,
            allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.SendMessagesInThreads],
          })),
        ];
        if (!category)
          category = await i.guild.channels.create({
            name: 'Bot Logs',
            type: ChannelType.GuildCategory,
            permissionOverwrites: permissions,
            reason: 'Bot log setup',
          });
        assert(category.type === ChannelType.GuildCategory, 'Choose a category.');
        assert(
          !category.permissionsFor(i.guild.roles.everyone)?.has(P.ViewChannel),
          'The log category must be private. Deny @everyone View Channel, or omit category to create Bot Logs.',
        );
        const grants = permissions
          .filter((entry) => 'allow' in entry)
          .map((entry) => ({
            id: entry.id,
            bits: Object.fromEntries(
              new PermissionsBitField(entry.allow).toArray().map((name) => [name, true]),
            ),
          }));
        for (const grant of grants) await category.permissionOverwrites.edit(grant.id, grant.bits);
        cfg.logsCategory = category.id;
        app.store.setConfig(i.guildId, cfg, i.user.id);
        const result: string[] = [];
        for (const kind of logKinds) {
          cfg = app.store.config(i.guildId);
          let channel = channels.get(cfg.logs[kind] ?? '');
          if (
            !channel ||
            channel.type !== ChannelType.GuildText ||
            channel.parentId !== category.id
          )
            channel = channels.find(
              (c) =>
                c?.type === ChannelType.GuildText &&
                c.parentId === category!.id &&
                c.name === names[kind],
            );
          let created = false;
          if (!channel) {
            channel = await i.guild.channels.create({
              name: names[kind],
              type: ChannelType.GuildText,
              parent: category.id,
              permissionOverwrites: permissions,
              reason: 'Bot log setup',
            });
            created = true;
          }
          assert(
            channel.type === ChannelType.GuildText &&
              !channel.permissionsFor(i.guild.roles.everyone)?.has(P.ViewChannel),
            `Make ${names[kind]} private before continuing.`,
          );
          for (const grant of grants) await channel.permissionOverwrites.edit(grant.id, grant.bits);
          await botPermission(
            i.guild,
            [P.ViewChannel, P.SendMessages, P.ReadMessageHistory],
            channel,
          );
          cfg.logs[kind] = channel.id;
          app.store.setConfig(i.guildId, cfg, i.user.id);
          result.push(`${created ? 'Created' : 'Reused'} <#${channel.id}>`);
        }
        await reply(
          i,
          `## Logs ready\n${result.join('\n')}\n\nDM replies are handled in staff threads. ${cfg.staffRoles.length ? '' : 'Only the owner/administrators have access until staff roles are configured.'}`,
        );
      } finally {
        active.delete(i.guildId);
      }
    },
  },
};
