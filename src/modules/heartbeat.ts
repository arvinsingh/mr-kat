import { PermissionFlagsBits as P } from 'discord.js';
import type { App, Module } from '../types.js';
import { owner, requirePermission, botPermission } from '../permissions.js';
import { textChannel, send } from '../discord.js';
import { assert, errorText, logError } from '../util.js';
import { embed, reply } from '../ui.js';

interface HeartbeatState {
  attempted: number;
  sent?: number;
  error?: string;
}
const active = new WeakSet<App>();
export async function heartbeatTick(app: App) {
  if (active.has(app)) return;
  const cfg = app.store.config(app.guildId).heartbeat;
  if (!cfg.enabled || !cfg.channel) return;
  const previous = app.store.get<HeartbeatState>(app.guildId, 'system', 'heartbeat');
  if (previous && Date.now() - previous.attempted < cfg.minutes * 60000) return;
  active.add(app);
  const state: HeartbeatState = {
    attempted: Date.now(),
    ...(previous?.sent ? { sent: previous.sent } : {}),
  };
  // Persist before the request: restart/uncertain delivery cannot cause a burst.
  app.store.put(app.guildId, 'system', 'heartbeat', state);
  try {
    const latency = app.client.ws.ping;
    const connected = app.client.isReady();
    await send(app, app.guildId, cfg.channel, {
      embeds: [
        embed(
          `Bot heartbeat · ${connected ? 'online' : 'reconnecting'}`,
          `Status checked: <t:${Math.floor(state.attempted / 1000)}:F>\nGateway: ${connected ? 'connected' : 'reconnecting'}\nUptime: ${Math.floor((app.client.uptime ?? 0) / 60000)} minutes\nGateway latency: ${latency >= 0 ? `${Math.round(latency)} ms` : 'measuring'}\nNext check: in ${cfg.minutes} minute${cfg.minutes === 1 ? '' : 's'}.`,
          connected ? 'success' : 'warning',
        ),
      ],
    });
    state.sent = Date.now();
  } catch (error) {
    state.error = errorText(error);
    logError('heartbeat', error);
  } finally {
    app.store.put(app.guildId, 'system', 'heartbeat', state);
    active.delete(app);
  }
}
export const heartbeat: Module = {
  commands: {
    heartbeat: async (app, i) => {
      const action = i.options.getSubcommand();
      const cfg = app.store.config(i.guildId);
      if (action === 'status') {
        await requirePermission(app, i, P.ManageGuild);
        const state = app.store.get<HeartbeatState>(i.guildId, 'system', 'heartbeat');
        await reply(
          i,
          `Heartbeat: ${cfg.heartbeat.enabled ? 'on' : 'off'}\nChannel: ${cfg.heartbeat.channel ? `<#${cfg.heartbeat.channel}>` : 'not set'}\nInterval: ${cfg.heartbeat.minutes} minutes\nLast confirmed post: ${state?.sent ? `<t:${Math.floor(state.sent / 1000)}:F>` : 'none'}\nLast delivery issue: ${state?.error ? 'Delivery failed or was uncertain; check channel permissions and host logs.' : 'none'}\nAn offline bot cannot send a heartbeat. Missed intervals are not replayed.`,
        );
        return;
      }
      owner(i);
      if (action === 'setup') {
        const channel = await textChannel(app, i.guildId, i.options.getChannel('channel', true).id);
        assert(channel.type === 0, 'Choose a normal text channel for heartbeat posts.');
        await botPermission(i.guild, [P.SendMessages, P.EmbedLinks], channel);
        cfg.heartbeat = {
          enabled: true,
          channel: channel.id,
          minutes: i.options.getInteger('minutes') ?? 5,
        };
        app.store.setConfig(i.guildId, cfg, i.user.id);
        app.store.delete(i.guildId, 'system', 'heartbeat');
        await reply(
          i,
          `Heartbeat enabled in <#${channel.id}> every ${cfg.heartbeat.minutes} minutes. The first post follows shortly.`,
        );
      } else {
        assert(action === 'disable', 'Unknown heartbeat action.');
        cfg.heartbeat.enabled = false;
        app.store.setConfig(i.guildId, cfg, i.user.id);
        await reply(i, 'Heartbeat disabled. Existing status posts remain.');
      }
    },
  },
};
