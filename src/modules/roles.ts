import { auditChange } from '../change-receipts.js';
import { sendModern } from '../presentation.js';
import { logProfile } from '../log-profile.js';
import { ActionRowBuilder, StringSelectMenuBuilder, PermissionFlagsBits as P } from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { App, Module, Interaction, Component } from '../types.js';
import {
  enabled,
  manageableRole,
  safeRole,
  botPermission,
  requirePermission,
} from '../permissions.js';
import { assert, duration, parseIds, safe } from '../util.js';
import { confirm, reply, noMentions, type Confirmation } from '../ui.js';
import { parseBatchRoles } from '../batch-request.js';
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
        await requirePermission(app, i, P.ManageRoles, channel);
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
        const message = await sendModern(channel, {
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
      await auditChange(
        app,
        i,
        `Role ${action}`,
        `Role: <@&${fetched.id}>\nStaff: <@${i.user.id}>\nReason: ${safe(reason, Infinity)}`,
        { profile: logProfile(app, target.id, undefined, target) },
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
        const previous = app.store.get<RoleTimer>(i.guildId, 'roleTimer', key);
        let generation: string | undefined;
        if (cfg.selfRoleExpiryMinutes) {
          const timer = {
            generation: randomUUID(),
            expires: Date.now() + cfg.selfRoleExpiryMinutes * 60000,
            role: roleId,
            target: member.id,
          };
          generation = timer.generation;
          app.store.put(i.guildId, 'roleTimer', key, timer);
          app.store.job(i.guildId, i.user.id, 'roleExpire', { ...timer }, timer.expires);
        }
        try {
          await member.roles.add(roleId, 'Self-service role panel');
        } catch (error) {
          if (
            generation &&
            app.store.get<RoleTimer>(i.guildId, 'roleTimer', key)?.generation === generation
          ) {
            if (previous) app.store.put(i.guildId, 'roleTimer', key, previous);
            else app.store.delete(i.guildId, 'roleTimer', key);
          }
          throw error;
        }
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

export async function queueBatchRoles(app: App, i: Component, pending: Confirmation) {
  enabled(app, i.guildId, 'roles');
  const payload = parseBatchRoles(pending.payload);
  const role = await i.guild.roles.fetch(payload.role);
  assert(role, 'Role no longer exists.');
  await manageableRole(app, i, role);
  const key = app.store.job(i.guildId, i.user.id, 'batchRoles', payload);
  await reply(i, {
    content: `Batch queued. Use /jobs list for progress. Job: ${key}.`,
    components: [],
  });
}
