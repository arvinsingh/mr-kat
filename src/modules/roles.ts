import { ActionRowBuilder, StringSelectMenuBuilder, PermissionFlagsBits as P } from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Module, Interaction, Command } from '../types.js';
import { enabled, manageableRole, safeRole, botPermission } from '../permissions.js';
import { assert, duration, parseIds, safe } from '../util.js';
import { confirm, reply, noMentions } from '../ui.js';
import { destination } from '../discord.js';

export interface RoleTimer {
  generation: string;
  expires: number;
  role: string;
  target: string;
}
export async function temporaryRole(
  app: App,
  i: Interaction,
  target: string,
  roleId: string,
  milliseconds: number,
  reason: string,
) {
  const role = await i.guild!.roles.fetch(roleId);
  assert(role, 'Role not found.');
  await manageableRole(app, i, role, target);
  safeRole(role);
  const member = await i.guild!.members.fetch(target);
  const key = `${target}:${roleId}`;
  const previous = app.store.get<RoleTimer>(i.guildId!, 'roleTimer', key);
  assert(
    !member.roles.cache.has(roleId) || previous,
    'This member already holds that role without a bot timer. Remove it manually before making it temporary.',
  );
  const timer = {
    generation: randomUUID(),
    expires: Date.now() + milliseconds,
    role: roleId,
    target,
  };
  app.store.put(i.guildId!, 'roleTimer', key, timer);
  app.store.job(i.guildId!, i.user.id, 'roleExpire', { ...timer }, timer.expires);
  try {
    await member.roles.add(role, reason);
  } catch (error) {
    if (previous) app.store.put(i.guildId!, 'roleTimer', key, previous);
    else app.store.delete(i.guildId!, 'roleTimer', key);
    throw error;
  }
}
export const roles: Module = {
  commands: {
    role: async (app, i) => {
      enabled(app, i.guildId, 'roles');
      const action = i.options.getSubcommand();
      if (action === 'menu') {
        const channel = await destination(app, i, i.options.getChannel('channel', true).id);
        const cfg = app.store.config(i.guildId);
        assert(cfg.selfRoles.length, 'Configure selfRoles first using /config set.');
        const options = [];
        for (const roleId of cfg.selfRoles) {
          const role = await i.guild.roles.fetch(roleId);
          assert(role, 'A self-service role no longer exists.');
          safeRole(role);
          options.push({ label: role.name.slice(0, 100), value: role.id });
        }
        const menu = new StringSelectMenuBuilder()
          .setCustomId('roles:select')
          .setPlaceholder('Choose your community roles')
          .setMinValues(0)
          .setMaxValues(options.length)
          .addOptions(options);
        const message = await channel.send({
          content:
            'Select the community roles you want. Unselected roles from this panel will be removed.',
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
          allowedMentions: noMentions,
        });
        app.store.put(i.guildId, 'rolePanel', message.id, { roles: cfg.selfRoles });
        await reply(i, 'Role panel published.');
        return;
      }
      const role = i.options.getRole('role', true);
      const fetched = await i.guild.roles.fetch(role.id);
      assert(fetched, 'Role not found.');
      const reason = i.options.getString('reason', true);
      if (action === 'bulk') {
        await manageableRole(app, i, fetched);
        const targets = parseIds(i.options.getString('members', true));
        for (const target of targets) await manageableRole(app, i, fetched, target);
        await confirm(
          app,
          i,
          `${i.options.getString('action', true)} ${safe(fetched.name)} for ${targets.length} selected members?\n${safe(reason)}`,
          'batchRoles',
          { role: fetched.id, targets, action: i.options.getString('action', true), reason },
        );
        return;
      }
      const target = i.options.getUser('member', true);
      await manageableRole(app, i, fetched, target.id);
      if (action === 'temporary')
        await temporaryRole(
          app,
          i,
          target.id,
          role.id,
          duration(i.options.getString('duration', true)),
          reason,
        );
      else {
        const member = await i.guild.members.fetch(target.id);
        if (action === 'add') await member.roles.add(role.id, reason);
        else await member.roles.remove(role.id, reason);
        app.store.delete(i.guildId, 'roleTimer', `${target.id}:${role.id}`);
      }
      app.store.addCase(i.guildId, i.user.id, target.id, `role:${action}`, `${role.id}: ${reason}`);
      await app.audit(
        i.guildId,
        'admin',
        `Role ${action}`,
        `<@${i.user.id}> changed <@&${fetched.id}> · ${safe(fetched.name)} for <@${target.id}>. ${safe(reason, Infinity)}`,
      );
      await reply(i, 'Role updated.');
    },
  },
  component: async (app, i) => {
    if (!i.isStringSelectMenu() || i.customId !== 'roles:select') return false;
    enabled(app, i.guildId, 'roles');
    const cfg = app.store.config(i.guildId);
    const panel = app.store.get<{ roles: string[] }>(i.guildId, 'rolePanel', i.message.id);
    assert(panel, 'This panel is no longer valid.');
    const allowed = panel.roles.filter((r) => cfg.selfRoles.includes(r));
    assert(
      i.values.every((r) => allowed.includes(r)),
      'This panel is out of date. Ask staff to publish it again.',
    );
    const selected = new Set(i.values);
    const member = await i.guild.members.fetch(i.user.id);
    const me = await botPermission(i.guild, P.ManageRoles);
    for (const group of cfg.roleExclusiveGroups)
      assert(
        group.filter((r) => selected.has(r) || (!allowed.includes(r) && member.roles.cache.has(r)))
          .length <= 1,
        'Choose only one role from each exclusive group.',
      );
    const resultingRoles = new Set(
      [...member.roles.cache.keys()].filter((role) => !allowed.includes(role)),
    );
    for (const role of selected) resultingRoles.add(role);
    for (const roleId of selected) {
      const prerequisite = cfg.rolePrerequisites[roleId];
      assert(
        !prerequisite || resultingRoles.has(prerequisite),
        'Your final selection must retain each required prerequisite role.',
      );
    }
    // Validate the complete operation before making any role changes.
    for (const roleId of allowed) {
      const role = await i.guild.roles.fetch(roleId);
      assert(role, 'A panel role no longer exists.');
      safeRole(role);
      assert(
        !cfg.protectedRoles.includes(roleId) && me.roles.highest.comparePositionTo(role) > 0,
        'This role is protected or above the bot.',
      );
    }
    for (const roleId of allowed) {
      const has = member.roles.cache.has(roleId);
      const key = `${member.id}:${roleId}`;
      if (selected.has(roleId) && !has) {
        if (cfg.selfRoleExpiryMinutes) {
          const timer = {
            generation: randomUUID(),
            expires: Date.now() + cfg.selfRoleExpiryMinutes * 60000,
            role: roleId,
            target: member.id,
          };
          app.store.put(i.guildId, 'roleTimer', key, timer);
          app.store.job(i.guildId, i.user.id, 'roleExpire', { ...timer }, timer.expires);
        }
        await member.roles.add(roleId, 'Self-service role panel');
      }
      if (!selected.has(roleId) && has) {
        await member.roles.remove(roleId, 'Self-service role panel');
        app.store.delete(i.guildId, 'roleTimer', key);
      }
    }
    await reply(i, 'Your community roles were updated.');
    return true;
  },
};
