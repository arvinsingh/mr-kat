import { sendModern, modernModal } from '../presentation.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits as P,
  type VoiceState,
  type Guild,
  type VoiceChannel,
  type GuildMember,
  type GuildBasedChannel,
} from 'discord.js';
import type { App, Module, Interaction } from '../types.js';
import { requirePermission, botPermission, enabled, manageableMember } from '../permissions.js';
import { assert, safe, logError, errorText } from '../util.js';
import { embed, reply, noMentions } from '../ui.js';
import { missingChannel, textChannel, send } from '../discord.js';
import { channelNotice } from '../notices.js';
import { channelLabel } from '../channel-label.js';
export interface VoiceRoom {
  owner: string;
  name?: string;
  companion?: string;
  created: number;
  blocked: string[];
  permitted: string[];
}
const busy = new Set<string>();

const guildPermissions: [string, bigint][] = [
  ['Manage Channels', P.ManageChannels],
  ['Manage Roles (Manage Permissions)', P.ManageRoles],
  ['Move Members', P.MoveMembers],
  ['Send Messages', P.SendMessages],
  ['Embed Links', P.EmbedLinks],
  ['Read Message History', P.ReadMessageHistory],
];
const lobbyPermissions: [string, bigint][] = [
  ['View Channel', P.ViewChannel],
  ['Connect', P.Connect],
  ['Move Members', P.MoveMembers],
];
const categoryPermissions: [string, bigint][] = [
  ['View Channel', P.ViewChannel],
  ['Manage Channels', P.ManageChannels],
  ['Manage Roles (Manage Permissions)', P.ManageRoles],
];
function missingPermissions(
  member: GuildMember,
  required: [string, bigint][],
  channel?: GuildBasedChannel,
): string[] {
  const permissions = channel ? channel.permissionsFor(member) : member.permissions;
  return required.filter(([, flag]) => !permissions?.has(flag)).map(([name]) => name);
}
export async function validateVoiceSetup(
  guild: Guild,
  lobby: VoiceChannel,
  category: GuildBasedChannel,
): Promise<void> {
  const me = await guild.members.fetchMe();
  for (const [scope, required, channel] of [
    ['server', guildPermissions, undefined],
    ['lobby', lobbyPermissions, lobby],
    ['destination category', categoryPermissions, category],
  ] as const) {
    const missing = missingPermissions(me, required, channel);
    assert(
      !missing.length,
      `Voice setup: the bot is missing ${missing.join(', ')} in the ${scope}. Update its role/channel permissions and retry.`,
    );
  }
}

async function voiceStatus(app: App, i: Interaction) {
  const cfg = app.store.config(i.guildId!);
  const guild = i.guild!;
  const me = await guild.members.fetchMe();
  const lobby = cfg.voiceLobby
    ? await guild.channels.fetch(cfg.voiceLobby).catch(missingChannel)
    : null;
  const category = cfg.voiceCategory
    ? await guild.channels.fetch(cfg.voiceCategory).catch(missingChannel)
    : null;
  const problems: string[] = [];
  if (!cfg.modules.voice) problems.push('The voice module is disabled.');
  if (!lobby || lobby.type !== ChannelType.GuildVoice)
    problems.push('No valid voice lobby is configured.');
  if (!category || category.type !== ChannelType.GuildCategory)
    problems.push('No valid destination category is configured.');
  const missingServer = missingPermissions(me, guildPermissions);
  if (missingServer.length)
    problems.push(`Server permissions missing: ${missingServer.join(', ')}.`);
  if (lobby?.type === ChannelType.GuildVoice) {
    const missing = missingPermissions(me, lobbyPermissions, lobby);
    if (missing.length) problems.push(`Lobby permissions missing: ${missing.join(', ')}.`);
  }
  if (category?.type === ChannelType.GuildCategory) {
    const missing = missingPermissions(me, categoryPermissions, category);
    if (missing.length) problems.push(`Category permissions missing: ${missing.join(', ')}.`);
  }
  await reply(
    i,
    [
      `Voice rooms: ${problems.length ? 'setup needs attention' : 'ready'}`,
      `Lobby: ${lobby?.type === ChannelType.GuildVoice ? `<#${lobby.id}>` : 'not configured or deleted'}`,
      `Category: ${category?.type === ChannelType.GuildCategory ? `<#${category.id}>` : 'not configured or deleted'}`,
      'Text chat: built into each voice room; no separate companion channel is created.',
      `Creation notices: ${cfg.voiceNoticeChannel ? `<#${cfg.voiceNoticeChannel}>` : 'not configured; set notice_channel with /voice setup'}`,
      `Tracked rooms: ${app.store.entries(guild.id, 'voiceRoom').length}/30`,
      ...problems,
      lobby?.type === ChannelType.GuildVoice
        ? `To create your room, join <#${lobby.id}>. If already there, leave and rejoin.`
        : 'The server owner must select existing channels with /voice setup.',
      'Room controls work only in temporary rooms created by this bot. Use /help command:voice for the full walkthrough.',
    ].join('\n'),
  );
}

async function creationFailed(app: App, state: VoiceState, error: unknown) {
  logError('voice creation', error);
  const notice = app.store.get<{ until: number }>(state.guild.id, 'voiceFailureNotice', state.id);
  if (notice && notice.until > Date.now()) return;
  app.store.put(state.guild.id, 'voiceFailureNotice', state.id, { until: Date.now() + 30000 });
  const description = `Could not create a voice room for <@${state.id}>. ${safe(errorText(error), 700)}\nUse /voice status to inspect setup and permissions.`;
  await Promise.allSettled([
    app.audit(state.guild.id, 'admin', 'Voice room creation failed', description),
    ...(state.member
      ? [
          sendModern(state.member, {
            content: `${description}\nAsk the server owner to resolve the problem, then leave and rejoin the lobby.`,
            allowedMentions: noMentions,
          }),
        ]
      : []),
  ]);
}

export async function reconcileVoice(app: App, guild: Guild) {
  for (const { key, data } of app.store.entries<VoiceRoom>(guild.id, 'voiceRoom')) {
    const channel = await guild.channels.fetch(key).catch(missingChannel);
    if (!channel) {
      if (data.companion)
        await guild.channels
          .delete(data.companion, 'Orphaned companion cleanup')
          .catch(missingChannel);
      app.store.delete(guild.id, 'voiceRoom', key);
      continue;
    }
    if (channel.type !== ChannelType.GuildVoice) continue;
    if (!channel.members.size) {
      await removeRoom(app, channel, data);
    }
  }
}
async function removeRoom(app: App, channel: VoiceChannel, room: VoiceRoom) {
  if (channel.members.size) return;
  if (room.companion)
    await channel.guild.channels
      .delete(room.companion, 'Empty managed voice room')
      .catch(missingChannel);
  await channel.delete('Empty managed voice room');
  app.store.delete(channel.guild.id, 'voiceRoom', channel.id);
}
export async function syncCompanion(app: App, channel: VoiceChannel, room: VoiceRoom) {
  if (!room.companion) return;
  const text = await channel.guild.channels.fetch(room.companion);
  if (text?.type !== ChannelType.GuildText) return;
  const staff = app.store.config(channel.guild.id).staffRoles;
  const desired = new Set(
    [room.owner, ...room.permitted, ...channel.members.keys()].filter(
      (key) => !room.blocked.includes(key),
    ),
  );
  for (const overwrite of text.permissionOverwrites.cache.values())
    if (overwrite.type === 1 && overwrite.id !== app.client.user!.id && !desired.has(overwrite.id))
      await overwrite.delete('Sync voice room access');
  for (const key of desired)
    await text.permissionOverwrites.edit(key, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
  for (const key of staff)
    await text.permissionOverwrites.edit(key, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
}
export function voiceCard(channel: Pick<VoiceChannel, 'id' | 'name'>, room: VoiceRoom) {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '## Your voice room\n' +
        channelLabel(channel.id, channel.name) +
        ' · <@' +
        room.owner +
        '>\nCreated: <t:' +
        Math.floor(room.created / 1000) +
        ':f> · Deletes when empty.',
    ),
  );
  for (const [action, label, description] of [
    ['rename', 'Rename', 'Change the room name'],
    ['limit', 'Capacity', 'Set the member limit'],
    ['lock', 'Lock', 'Stop new joins'],
    ['unlock', 'Unlock', 'Allow new joins'],
    ['permit', 'Permit', 'Allow a member'],
    ['block', 'Block', 'Remove and block a member'],
    ['transfer', 'Transfer', 'Choose a new owner'],
    ['claim', 'Claim', 'Take over after the owner leaves'],
  ])
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(description!))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId('voice:' + action + ':' + channel.id)
            .setLabel(label!)
            .setStyle(ButtonStyle.Secondary),
        ),
    );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('-# Stay connected to use controls. /help command:voice'),
  );
  return { components: [container], allowedMentions: noMentions };
}
async function postVoiceControls(app: App, channel: VoiceChannel, room: VoiceRoom) {
  try {
    await botPermission(channel.guild, [P.SendMessages, P.EmbedLinks], channel);
    await sendModern(channel, {
      ...voiceCard(channel, room),
      allowedMentions: { parse: [], users: [room.owner], roles: [], repliedUser: false },
      nonce: channel.id,
      enforceNonce: true,
    });
  } catch (error) {
    logError('voice room controls', error);
    await app
      .audit(
        channel.guild.id,
        'admin',
        'Voice room controls could not be confirmed',
        `Room ${channelLabel(channel.id, channel.name)} is created, but its command message could not be confirmed. Check Send Messages and Embed Links. Use /voice panel while connected.`,
        { force: true },
      )
      .catch((failure) => logError('voice controls log', failure));
  }
}
export async function voiceEvent(app: App, oldState: VoiceState, next: VoiceState) {
  const guild = next.guild;
  const cfg = app.store.config(guild.id);
  if (oldState.channelId !== next.channelId) {
    // Logging is independent: a slow or unavailable log channel must not block
    // moving a member or cleaning up an empty room.
    void app
      .audit(
        guild.id,
        'voice',
        'Voice movement',
        `<@${next.id}>: ${oldState.channelId ? channelLabel(oldState.channelId, oldState.channel?.name) : 'disconnected'} → ${next.channelId ? channelLabel(next.channelId, next.channel?.name) : 'disconnected'}`,
      )
      .catch((error) => logError('voice movement log', error));
    if (cfg.modules.stats) {
      const connected = app.store.get<{ since: number }>(guild.id, 'voiceActivity', next.id);
      if (connected)
        app.store.count(
          guild.id,
          'voiceSeconds',
          Math.min(86400, Math.floor((Date.now() - connected.since) / 1000)),
        );
      if (next.channelId && !cfg.excludedChannels.includes(next.channelId))
        app.store.put(guild.id, 'voiceActivity', next.id, { since: Date.now() });
      else app.store.delete(guild.id, 'voiceActivity', next.id);
    }
  }
  if (!cfg.modules.voice) return;
  // Mute/deafen/stream changes are not joins and must never provision another room.
  if (oldState.channelId === next.channelId) return;
  if (oldState.channel?.type === ChannelType.GuildVoice && oldState.channelId !== next.channelId) {
    const room = app.store.get<VoiceRoom>(guild.id, 'voiceRoom', oldState.channel.id);
    if (room && !busy.has(oldState.channel.id)) {
      busy.add(oldState.channel.id);
      try {
        if (!oldState.channel.members.size) await removeRoom(app, oldState.channel, room);
        else await syncCompanion(app, oldState.channel, room);
      } finally {
        busy.delete(oldState.channel.id);
      }
    }
  }
  if (next.channelId) {
    const room = app.store.get<VoiceRoom>(guild.id, 'voiceRoom', next.channelId);
    if (room && next.channel?.type === ChannelType.GuildVoice) {
      if (room.blocked.includes(next.id)) await next.disconnect('Blocked from this managed room');
      else await syncCompanion(app, next.channel, room);
    }
  }
  if (next.channelId !== cfg.voiceLobby || !next.member || next.member.user.bot) return;
  const key = `create:${guild.id}:${next.id}`;
  if (busy.has(key)) return;
  busy.add(key);
  let created: VoiceChannel | undefined;
  try {
    const owned = app.store
      .entries<VoiceRoom>(guild.id, 'voiceRoom')
      .find((e) => e.data.owner === next.id);
    if (owned) {
      const existing = await guild.channels.fetch(owned.key).catch(missingChannel);
      if (existing?.type === ChannelType.GuildVoice) {
        await next.setChannel(existing, 'Return to existing room');
        return;
      }
      if (!existing) {
        if (owned.data.companion)
          await guild.channels
            .delete(owned.data.companion, 'Orphaned companion cleanup')
            .catch(missingChannel);
        app.store.delete(guild.id, 'voiceRoom', owned.key);
      }
    }
    assert(
      app.store.entries(guild.id, 'voiceRoom').length < 30,
      'Managed voice room capacity reached.',
    );
    const category = cfg.voiceCategory
      ? await guild.channels.fetch(cfg.voiceCategory).catch(missingChannel)
      : null;
    assert(
      category?.type === ChannelType.GuildCategory,
      'The destination category is missing. Ask the server owner to run /voice setup.',
    );
    assert(next.channel?.type === ChannelType.GuildVoice, 'The voice lobby no longer exists.');
    await validateVoiceSetup(guild, next.channel, category);
    if (next.member.voice.channelId !== cfg.voiceLobby) return;
    created = await guild.channels.create({
      name: `${next.member.displayName.slice(0, 65)}'s room`,
      type: ChannelType.GuildVoice,
      parent: cfg.voiceCategory ?? next.channel?.parentId,
      permissionOverwrites: [
        {
          id: guild.id,
          allow: [
            P.ViewChannel,
            P.Connect,
            P.SendMessages,
            P.ReadMessageHistory,
            P.UseApplicationCommands,
          ],
        },
        {
          id: next.id,
          allow: [
            P.ViewChannel,
            P.Connect,
            P.SendMessages,
            P.ReadMessageHistory,
            P.UseApplicationCommands,
          ],
        },
        {
          id: app.client.user!.id,
          allow: [
            P.ViewChannel,
            P.Connect,
            P.ManageChannels,
            P.MoveMembers,
            P.SendMessages,
            P.EmbedLinks,
            P.ReadMessageHistory,
          ],
        },
      ],
      reason: `Temporary room for ${next.id}`,
    });
    const room: VoiceRoom = {
      owner: next.id,
      name: created.name,
      created: Date.now(),
      blocked: [],
      permitted: [],
    };
    app.store.put(guild.id, 'voiceRoom', created.id, room);
    if (next.member.voice.channelId === cfg.voiceLobby) {
      await next.member.voice.setChannel(created, 'Join-to-create');
      await postVoiceControls(app, created, room);
      if (cfg.voiceNoticeChannel)
        await send(app, guild.id, cfg.voiceNoticeChannel, {
          content: `Temporary VC created by <@${room.owner}>: ${channelLabel(created.id, created.name)}\nCreated: <t:${Math.floor(room.created / 1000)}:f>.`,
        }).catch(() =>
          app.audit(
            guild.id,
            'admin',
            'Channel notice could not be confirmed',
            `Voice room ${channelLabel(created!.id, created!.name)} is ready; its creation notice could not be delivered.`,
            { force: true },
          ),
        );
    } else await removeRoom(app, created, room);
  } catch (error) {
    await creationFailed(app, next, error);
    if (created) {
      const room = app.store.get<VoiceRoom>(guild.id, 'voiceRoom', created.id);
      if (room && !created.members.size)
        await removeRoom(app, created, room).catch((e) => logError('voice rollback', e));
    }
  } finally {
    busy.delete(key);
  }
}
async function control(app: App, i: Interaction, action: string, value?: string | number) {
  enabled(app, i.guildId!, 'voice');
  const member = await i.guild!.members.fetch(i.user.id);
  const channel = member.voice.channel;
  assert(channel?.type === ChannelType.GuildVoice, 'Join a temporary voice room first.');
  const room = app.store.get<VoiceRoom>(i.guildId!, 'voiceRoom', channel.id);
  assert(room, 'This is not a room managed by this bot.');
  if (action === 'claim') {
    assert(!channel.members.has(room.owner), 'The owner is still in the room.');
    room.owner = i.user.id;
    app.store.put(i.guildId!, 'voiceRoom', channel.id, room);
    await syncCompanion(app, channel, room);
    await reply(i, 'You now own this room.');
    return;
  }
  assert(room.owner === i.user.id, 'Only the room owner can use this control.');
  assert(!busy.has(channel.id), 'Room update in progress; try again shortly.');
  busy.add(channel.id);
  try {
    await botPermission(channel.guild, P.ManageChannels, channel);
    if (action === 'rename') {
      assert(typeof value === 'string' && value.trim().length > 0, 'Supply a name.');
      await channel.setName(value.slice(0, 90));
    }
    if (action === 'limit') await channel.setUserLimit(Number(value));
    if (action === 'lock' || action === 'unlock')
      await channel.permissionOverwrites.edit(i.guildId!, { Connect: action === 'unlock' });
    if (action === 'permit' || action === 'block') {
      assert(
        typeof value === 'string' && value !== room.owner && value !== app.client.user!.id,
        'Choose another member.',
      );
      const target = await i.guild!.members.fetch(value);
      assert(target.id !== i.guild!.ownerId, 'The server owner is protected.');
      if (action === 'block') {
        const cfg = app.store.config(i.guildId!);
        assert(
          !cfg.protectedRoles.some((r) => target.roles.cache.has(r)) &&
            !cfg.staffRoles.some((r) => target.roles.cache.has(r)) &&
            !target.permissions.has(P.Administrator),
          'Staff and protected members cannot be blocked.',
        );
        room.blocked = [...new Set([...room.blocked, value])];
        room.permitted = room.permitted.filter((id) => id !== value);
      } else {
        room.permitted = [...new Set([...room.permitted, value])];
        room.blocked = room.blocked.filter((id) => id !== value);
      }
      await channel.permissionOverwrites.edit(value, {
        ViewChannel: action === 'permit',
        Connect: action === 'permit',
        SendMessages: action === 'permit',
        ReadMessageHistory: action === 'permit',
        UseApplicationCommands: action === 'permit',
      });
      app.store.put(i.guildId!, 'voiceRoom', channel.id, room);
      if (action === 'block' && target.voice.channelId === channel.id)
        await target.voice.disconnect('Room owner blocked access');
    }
    if (action === 'transfer') {
      assert(
        typeof value === 'string' && channel.members.has(value),
        'Choose a member currently in this room.',
      );
      room.owner = value;
      await channel.permissionOverwrites.edit(value, { ViewChannel: true, Connect: true });
    }
    app.store.put(i.guildId!, 'voiceRoom', channel.id, room);
    await syncCompanion(app, channel, room);
    await reply(i, `Room ${action} updated.`);
  } finally {
    busy.delete(channel.id);
  }
}
export const voice: Module = {
  commands: {
    voice: async (app, i) => {
      const action = i.options.getSubcommand();
      if (action === 'status') {
        await voiceStatus(app, i);
        return;
      }
      enabled(app, i.guildId, 'voice');
      if (action === 'setup') {
        await requirePermission(app, i, P.ManageGuild);
        assert(i.user.id === i.guild.ownerId, 'Only the owner can configure voice creation.');
        const lobby = await i.guild.channels.fetch(i.options.getChannel('lobby', true).id),
          category = await i.guild.channels.fetch(i.options.getChannel('category', true).id);
        assert(
          lobby?.type === ChannelType.GuildVoice && category?.type === ChannelType.GuildCategory,
          'Choose a voice lobby and channel category.',
        );
        await validateVoiceSetup(i.guild, lobby, category);
        const noticeId = i.options.getChannel('notice_channel')?.id;
        if (noticeId) {
          const notice = await textChannel(app, i.guildId, noticeId);
          assert(
            notice.type === ChannelType.GuildText,
            'Choose a normal text channel for room notices.',
          );
          await botPermission(i.guild, [P.SendMessages, P.EmbedLinks], notice);
        }
        assert(
          !app.store.get(i.guildId, 'voiceRoom', lobby.id),
          'Choose a permanent lobby, not a temporary room managed by this bot.',
        );
        const cfg = app.store.config(i.guildId);
        cfg.voiceLobby = lobby.id;
        cfg.voiceCategory = category.id;
        cfg.voiceCompanion = false;
        if (noticeId) cfg.voiceNoticeChannel = noticeId;
        app.store.setConfig(i.guildId, cfg, i.user.id);
        await reply(
          i,
          'Join-to-create voice rooms configured and bot permissions checked. Leave and rejoin the selected lobby to create your room. Use /voice status to inspect this configuration.',
        );
        return;
      }
      if (action === 'move') {
        const target = await manageableMember(
          app,
          i,
          i.options.getUser('member', true).id,
          P.MoveMembers,
        );
        const channel = await i.guild.channels.fetch(i.options.getChannel('channel', true).id);
        assert(channel?.type === ChannelType.GuildVoice, 'Choose a voice channel.');
        await requirePermission(app, i, [P.ViewChannel, P.Connect], channel);
        await target.voice.setChannel(channel);
        await reply(i, 'Member moved.');
        return;
      }
      if (action === 'panel') {
        const member = await i.guild.members.fetch(i.user.id);
        const channel = member.voice.channel;
        assert(channel?.type === ChannelType.GuildVoice, 'Join a temporary voice room first.');
        const room = app.store.get<VoiceRoom>(i.guildId, 'voiceRoom', channel.id);
        assert(room, 'This is not a managed room.');
        await reply(i, voiceCard(channel, room));
        return;
      }
      await control(
        app,
        i,
        action,
        i.options.getString('name') ??
          i.options.getInteger('count') ??
          i.options.getUser('member')?.id,
      );
    },
  },
  component: async (app, i) => {
    if (!i.customId.startsWith('voice:')) return false;
    const [, action, roomId, actor] = i.customId.split(':');
    const member = await i.guild!.members.fetch(i.user.id);
    const channel = member.voice.channel;
    assert(
      channel?.type === ChannelType.GuildVoice && (!roomId || channel.id === roomId),
      'Join this voice room first.',
    );
    const room = app.store.get<VoiceRoom>(i.guildId!, 'voiceRoom', channel.id);
    assert(room, 'This room no longer exists.');
    if (actor) assert(actor === i.user.id, 'Open your own voice control.');
    if (i.isButton() && ['rename', 'limit'].includes(action!)) {
      assert(room.owner === i.user.id, 'Only the room owner can use this control.');
      await i.showModal(
        modernModal(
          new ModalBuilder()
            .setCustomId('voice:' + action + ':' + channel.id + ':' + i.user.id)
            .setTitle(action === 'rename' ? 'Rename voice room' : 'Room capacity')
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId('value')
                  .setLabel(
                    action === 'rename' ? 'Room name' : 'Member limit (0–99; 0 = unlimited)',
                  )
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(action === 'rename' ? 90 : 2)
                  .setRequired(true),
              ),
            ),
        ),
      );
      return true;
    }
    if (i.isButton() && ['permit', 'block', 'transfer'].includes(action!)) {
      assert(room.owner === i.user.id, 'Only the room owner can use this control.');
      await reply(i, {
        content: 'Choose a member.',
        components: [
          new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId('voice:' + action + ':' + channel.id + ':' + i.user.id)
              .setPlaceholder('Choose a member')
              .setMaxValues(1),
          ),
        ],
      });
      return true;
    }
    assert(
      ['lock', 'unlock', 'claim', 'rename', 'limit', 'permit', 'block', 'transfer'].includes(
        action!,
      ),
      'Unknown voice control.',
    );
    let value: string | number | undefined;
    if (i.isModalSubmit()) {
      value = i.fields.getTextInputValue('value');
      if (action === 'limit') {
        assert(/^\d{1,2}$/.test(value), 'Use a limit from 0 to 99.');
        value = Number(value);
      }
    }
    if (i.isUserSelectMenu?.()) value = i.values[0];
    await control(app, i, action!, value);
    return true;
  },
};
