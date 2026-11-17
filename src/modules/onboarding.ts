import { modernEdit } from '../presentation.js';
import { logProfile } from '../log-profile.js';
import { PermissionFlagsBits as P, type GuildMember, type ButtonInteraction } from 'discord.js';
import type { App, Module } from '../types.js';
import type { GuildConfig } from '../config.js';
import { owner, safeRole, botPermission } from '../permissions.js';
import { assert, safe, parseIds, renderTemplate } from '../util.js';
import { embed, reply, linkButtons } from '../ui.js';
import { send } from '../discord.js';
import { directMessage } from '../dm.js';
import { validateConfig } from './admin.js';

interface Progress {
  joined: number;
  publicStarted?: boolean;
  dmStarted?: boolean;
  deferred?: boolean;
  roles: string[];
  errors: string[];
  dm?: string;
}
const active = new Set<string>();
export async function onboardingDestinations(member: GuildMember, cfg: GuildConfig) {
  const lines: { label: string; url: string }[] = [];
  for (const [label, id] of [
    ['Read the rules', cfg.rulesChannel],
    ['Choose roles', cfg.rolesSource === 'channel' ? cfg.rolesChannel : undefined],
    ['Introduce yourself', cfg.introductionChannel],
  ]) {
    if (!id) continue;
    const channel = await member.guild.channels.fetch(id).catch(() => null);
    if (channel?.permissionsFor(member)?.has(P.ViewChannel))
      lines.push({ label: label!, url: `https://discord.com/channels/${member.guild.id}/${id}` });
  }
  return lines;
}
export async function onboardingButtons(member: GuildMember, cfg: GuildConfig) {
  const links = await onboardingDestinations(member, cfg);
  if (cfg.rolesSource === 'native') {
    links.unshift(
      {
        label: 'Open server',
        url: links[0]?.url ?? `https://discord.com/channels/${member.guild.id}`,
      },
      {
        label: 'Channels & Roles (desktop)',
        url: `https://discord.com/channels/${member.guild.id}/customize-community`,
      },
    );
  }
  return linkButtons(links);
}
const nativeRolesInstructions =
  '**Mobile roles:** open the server channel list → **Channels & Roles** → **Customize** if shown. Use **Open server** below to reach the server; the desktop shortcut can open a blank page on mobile.';
export function welcomeDMText(member: GuildMember, cfg: GuildConfig) {
  return `${renderTemplate(cfg.welcomeDMText, member.user, member.guild.name)}${cfg.rolesSource === 'native' ? `\n\n${nativeRolesInstructions}` : ''}`;
}
// Upgrade an older Choose roles button in-place, including in DMs. No new message.
export async function nativeRolesHelp(app: App, i: ButtonInteraction) {
  if (
    i.customId !== `onboarding:roles:${app.guildId}` ||
    i.message.author.id !== app.client.user?.id
  )
    return false;
  await i.deferUpdate();
  try {
    const guild = await app.client.guilds.fetch(app.guildId);
    const member = await guild.members.fetch(i.user.id);
    const cfg = app.store.config(app.guildId);
    await i.editReply(
      modernEdit({
        content: nativeRolesInstructions,
        components: await onboardingButtons(member, { ...cfg, rolesSource: 'native' }),
        allowedMentions: { parse: [] },
      }),
    );
  } catch {
    await i.editReply(
      modernEdit({
        content:
          'Open the server’s channel list → Channels & Roles → Customize. You must still be a member of the server. If the page is unavailable, contact staff.',
        components: [],
      }),
    );
  }
  return true;
}
export async function onboardMember(app: App, member: GuildMember, joining = false) {
  const cfg = app.store.config(member.guild.id);
  if (!cfg.modules.onboarding || member.user.bot) return;
  const key = `${member.guild.id}:${member.id}`;
  if (active.has(key)) return;
  active.add(key);
  try {
    const joined = member.joinedTimestamp ?? 0;
    let progress = app.store.get<Progress>(member.guild.id, 'onboardingProgress', member.id);
    if (!progress || progress.joined !== joined) progress = { joined, roles: [], errors: [] };
    const save = () => app.store.put(member.guild.id, 'onboardingProgress', member.id, progress);
    const failure = (message: string) => {
      progress!.errors = [...progress!.errors.slice(-9), message];
      save();
    };
    if (joining && cfg.publicWelcome && !progress.publicStarted && cfg.welcomeChannel) {
      progress.publicStarted = true;
      save();
      try {
        await send(app, member.guild.id, cfg.welcomeChannel, {
          embeds: [
            embed(
              'Welcome!',
              renderTemplate(cfg.welcomeText, member.user, member.guild.name),
              'success',
            ),
          ],
        });
      } catch {
        failure('Public welcome could not be confirmed; not retried automatically.');
      }
    }
    if (cfg.rolesAfterScreening && member.pending) {
      progress.deferred = true;
      save();
      app.store.put(member.guild.id, 'onboardingPending', member.id, { joined });
      return;
    }
    progress.deferred = false;
    save();
    const saved = app.store.get<{ roles: string[] }>(member.guild.id, 'roleRestore', member.id);
    const candidates = [
      ...new Set(
        [
          cfg.joinRole,
          ...cfg.joinRoles,
          ...(cfg.modules.roles
            ? (saved?.roles ?? []).filter((r) => cfg.restoreRoles.includes(r))
            : []),
        ].filter((v): v is string => Boolean(v)),
      ),
    ];
    for (const id of candidates) {
      if (
        progress.roles.includes(id) ||
        id === cfg.verifiedRole ||
        cfg.protectedRoles.includes(id) ||
        app.store.get(member.guild.id, 'roleTimer', `${member.id}:${id}`)
      )
        continue;
      try {
        const role = await member.guild.roles.fetch(id);
        assert(role, 'Role missing.');
        safeRole(role);
        const me = await botPermission(member.guild, P.ManageRoles);
        assert(me.roles.highest.comparePositionTo(role) > 0, 'Role above bot.');
        if (!member.roles.cache.has(id))
          await member.roles.add(role, 'Configured onboarding / community-role restoration');
        progress.roles.push(id);
        save();
      } catch {
        failure(`Automatic role ${id} failed. Check role hierarchy and Manage Roles.`);
      }
    }
    if (cfg.welcomeDM && !progress.dmStarted) {
      progress.dmStarted = true;
      save();
      progress.dm = await directMessage(
        app,
        member.id,
        `Welcome to ${member.guild.name.slice(0, 180)}!`,
        welcomeDMText(member, cfg),
        'success',
        await onboardingButtons(member, cfg),
      );
      save();
      if (progress.dm !== 'sent')
        failure(
          `Welcome DM: ${progress.dm}. No duplicate DM is attempted. Public welcomes are separately controlled by public_welcome.`,
        );
    }
    app.store.delete(member.guild.id, 'onboardingPending', member.id);
    if (progress.errors.length)
      await app.audit(
        member.guild.id,
        'admin',
        'Onboarding needs attention',
        progress.errors.map((e) => safe(e, 160)).join('\n'),
        { profile: logProfile(app, member.id, member) },
      );
  } finally {
    active.delete(key);
  }
}
export async function reconcileOnboarding(app: App) {
  const guild = await app.client.guilds.fetch(app.guildId);
  for (const entry of app.store.entries<{ joined: number }>(
    app.guildId,
    'onboardingPending',
    1000,
  )) {
    let member: GuildMember;
    try {
      member = await guild.members.fetch(entry.key);
    } catch (error) {
      // Only a confirmed departure retires pending work; transport failures must retry.
      if ((error as { code?: number }).code === 10007)
        app.store.delete(app.guildId, 'onboardingPending', entry.key);
      continue;
    }
    if (!member || member.joinedTimestamp !== entry.data.joined)
      app.store.delete(app.guildId, 'onboardingPending', entry.key);
    else if (!member.pending) await onboardMember(app, member);
  }
}
export const onboarding: Module = {
  commands: {
    onboarding: async (app, i) => {
      owner(i);
      const action = i.options.getSubcommand();
      const cfg = app.store.config(i.guildId);
      if (action === 'status') {
        const me = await i.guild.members.fetchMe();
        const errors = app.store
          .entries<Progress>(i.guildId, 'onboardingProgress', 100)
          .filter((e) => e.data.errors.length)
          .slice(0, 5);
        const summary = `Onboarding: ${cfg.modules.onboarding ? 'on' : 'off'}\nPublic welcome: ${cfg.publicWelcome ? 'on' : 'off'}\nWelcome / exit channel: ${cfg.welcomeChannel ? `<#${cfg.welcomeChannel}>` : 'not set'}\nWelcome DM: ${cfg.welcomeDM ? 'on' : 'off'}\nWait for Rules Screening: ${cfg.rolesAfterScreening}\nAutomatic roles: ${
          [cfg.joinRole, ...cfg.joinRoles]
            .filter(Boolean)
            .map((r) => `<@&${r}>`)
            .join(', ') || 'none'
        }\nManage Roles: ${me.permissions.has(P.ManageRoles) ? 'yes' : 'missing'}\nPending screening: ${app.store.entries(i.guildId, 'onboardingPending', 1000).length}\nRecent issues: ${errors.map((e) => `<@${e.key}>: ${e.data.errors.map((v) => safe(v, 100)).join('; ')}`).join('\n') || 'none'}\nUse /diagnose for channel permissions. Existing members are not automatically backfilled.`;
        await reply(
          i,
          `${summary}\nRole selection: ${cfg.rolesSource === 'native' ? 'Discord Channels & Roles' : cfg.rolesSource === 'none' ? 'no role-selection link' : cfg.rolesChannel ? `<#${cfg.rolesChannel}>` : 'no roles channel selected'}`.slice(
            0,
            1900,
          ),
        );
        return;
      }
      if (action === 'preview') {
        const member = await i.guild.members.fetch(i.user.id);
        await reply(i, {
          embeds: [
            embed(
              cfg.publicWelcome ? 'Public welcome preview' : 'Public welcome · disabled',
              cfg.publicWelcome
                ? renderTemplate(cfg.welcomeText, i.user, i.guild.name)
                : 'Bot join welcomes are off. Native Discord welcomes are unaffected. Departure messages still use the configured welcome/exit channel.',
              'success',
            ),
            embed('Welcome DM preview', welcomeDMText(member, cfg), 'success'),
          ],
          components: await onboardingButtons(member, cfg),
        });
        return;
      }
      if (action === 'setup') {
        const rolesSource = i.options.getString('roles_source');
        assert(
          rolesSource === null ||
            rolesSource === 'channel' ||
            rolesSource === 'native' ||
            rolesSource === 'none',
          'Choose channel, native or none for roles_source.',
        );
        if (rolesSource) cfg.rolesSource = rolesSource;
        for (const [option, key] of [
          ['channel', 'welcomeChannel'],
          ['rules_channel', 'rulesChannel'],
          ['roles_channel', 'rolesChannel'],
          ['introduction_channel', 'introductionChannel'],
        ] as const) {
          const channel = i.options.getChannel(option);
          if (channel) cfg[key] = channel.id;
        }
        const dm = i.options.getBoolean('welcome_dm');
        if (dm !== null) cfg.welcomeDM = dm;
        const publicWelcome = i.options.getBoolean('public_welcome');
        if (publicWelcome !== null) cfg.publicWelcome = publicWelcome;
      } else if (action === 'message') {
        const text = i.options.getString('text'),
          dm = i.options.getString('dm_text');
        assert(text || dm, 'Provide text and/or dm_text.');
        if (text) {
          assert(text.trim() && text.length <= 1500, 'Use 1–1500 characters.');
          cfg.welcomeText = text;
        }
        if (dm) {
          assert(dm.trim() && dm.length <= 1500, 'Use 1–1500 characters.');
          cfg.welcomeDMText = dm;
        }
      } else if (action === 'autoroles') {
        const roles = i.options.getString('roles', true);
        cfg.joinRoles = roles.trim().toLowerCase() === 'none' ? [] : parseIds(roles);
        assert(
          !cfg.verifiedRole || !cfg.joinRoles.includes(cfg.verifiedRole),
          'Do not assign the verification role automatically. Use the verification workflow.',
        );
        if (cfg.joinRoles.length) await botPermission(i.guild, P.ManageRoles);
        delete cfg.joinRole;
        cfg.rolesAfterScreening = i.options.getBoolean('after_screening') ?? true;
      } else assert(false, 'Unknown onboarding action.');
      await validateConfig(app, i, cfg);
      app.store.setConfig(i.guildId, cfg, i.user.id);
      await reply(
        i,
        'Onboarding settings saved. Use /onboarding preview and /onboarding status. Enable the onboarding module if it is off. Changes apply to new members and pending screening, not all existing members.',
      );
    },
  },
};
