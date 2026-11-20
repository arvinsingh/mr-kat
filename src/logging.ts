import { PermissionFlagsBits as P, type GuildTextBasedChannel, type Message } from 'discord.js';
import type { App, AuditOptions } from './types.js';
import type { LogKind } from './config.js';
import { assert, errorText, logError } from './util.js';
import { textChannel } from './discord.js';
import { logPayloads } from './log-format.js';
import { noMentions } from './ui.js';
import { systemLogProfile } from './log-profile.js';

export interface LogHealth {
  sent: number;
  failed: number;
  dropped: number;
  partial: number;
  grouped: number;
  pending: number;
  lastError?: string;
  lastFailure?: number;
  lastSent?: number;
}
interface Task {
  critical: boolean;
  run: () => Promise<string | void>;
  resolve: (value: string | void) => void;
}
interface Warning {
  count: number;
  printed: number;
  at: number;
  latest: number;
  channel: string;
  message: string;
  kind: LogKind;
  title: string;
  text: string;
  options: AuditOptions;
  timer?: ReturnType<typeof setTimeout>;
}
const instances = new WeakMap<App, AuditLogger>();
const sensitive = new Set<LogKind>(['moderation', 'reports', 'admin', 'automod', 'dm']);
const staffPermissions = [
  P.Administrator,
  P.ManageGuild,
  P.ModerateMembers,
  P.ManageMessages,
  P.KickMembers,
  P.BanMembers,
];

export async function privateLogChannel(app: App, channel: GuildTextBasedChannel) {
  const cfg = app.store.config(app.guildId),
    guild = channel.guild;
  assert(
    !channel.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel),
    'Sensitive log destination is visible to everyone.',
  );
  for (const role of guild.roles.cache.values()) {
    if (
      role.id === guild.id ||
      role.tags?.botId ||
      cfg.staffRoles.includes(role.id) ||
      role.permissions.any(staffPermissions)
    )
      continue;
    assert(
      !channel.permissionsFor(role)?.has(P.ViewChannel),
      'An ordinary member role can view this sensitive log destination.',
    );
  }
  for (const overwrite of 'permissionOverwrites' in channel
    ? channel.permissionOverwrites.cache.values()
    : []) {
    if (
      overwrite.type !== 1 ||
      !overwrite.allow.has(P.ViewChannel) ||
      overwrite.id === app.client.user?.id ||
      overwrite.id === guild.ownerId
    )
      continue;
    const member = await guild.members.fetch(overwrite.id);
    assert(
      member.permissions.any(staffPermissions) ||
        cfg.staffRoles.some((id) => member.roles.cache.has(id)),
      'A non-staff member can view this sensitive log destination.',
    );
  }
}
export function logHealth(app: App): LogHealth {
  return (
    instances.get(app)?.health() ?? {
      sent: 0,
      failed: 0,
      dropped: 0,
      partial: 0,
      grouped: 0,
      ...app.store.get<LogHealth>(app.guildId, 'system', 'logHealth'),
      pending: 0,
    }
  );
}
export function logHealthText(app: App) {
  const h = logHealth(app);
  return `Queued/active: ${h.pending} · Delivered: ${h.sent}\nFailed: ${h.failed} · Partially delivered: ${h.partial} · Dropped: ${h.dropped} · Grouped warnings: ${h.grouped}\nLast issue: ${h.lastError ?? 'none'}${h.lastFailure ? ` · <t:${Math.floor(h.lastFailure / 1000)}:R>` : ''}\nCounters are retained across restarts; queued message bodies are not replayed.`;
}
// Direct inbox sends use per-user ordering rather than the event-log queue, but
// their failures must still appear in the same persistent delivery diagnostics.
export function reportLogFailure(app: App, error: unknown) {
  const logger = instances.get(app);
  if (logger) {
    logger.recordFailure(error);
    return;
  }
  const state = logHealth(app);
  try {
    app.store.put(app.guildId, 'system', 'logHealth', {
      ...state,
      failed: state.failed + 1,
      lastError: errorText(error),
      lastFailure: Date.now(),
      pending: 0,
    });
  } catch (failure) {
    logError('log health persistence', failure);
  }
  logError('log delivery', error);
}
export class AuditLogger {
  private queues = new Map<string, Task[]>();
  private running = new Map<string, Promise<void>>();
  private warnings = new Map<string, Warning>();
  private accepting = true;
  private state: LogHealth;
  constructor(private app: App) {
    this.state = logHealth(app);
    instances.set(app, this);
  }
  health() {
    return { ...this.state };
  }
  private save() {
    try {
      this.app.store.put(this.app.guildId, 'system', 'logHealth', { ...this.state, pending: 0 });
    } catch (error) {
      logError('log health persistence', error);
    }
  }
  private failure(error: unknown, partial = false) {
    this.state.failed++;
    if (partial) this.state.partial++;
    this.state.lastError = errorText(error);
    this.state.lastFailure = Date.now();
    this.save();
    logError('log delivery', error);
  }
  recordFailure(error: unknown) {
    this.failure(error);
  }
  private enqueue(channel: string, critical: boolean, run: Task['run']): Promise<string | void> {
    if (!this.accepting || this.state.pending >= (critical ? 500 : 100)) {
      this.state.dropped++;
      this.state.lastError = this.accepting
        ? 'Log queue capacity reached.'
        : 'Log delivery stopped during shutdown.';
      this.state.lastFailure = Date.now();
      this.save();
      return Promise.resolve();
    }
    this.state.pending++;
    return new Promise((resolve) => {
      let queue = this.queues.get(channel);
      if (!queue) this.queues.set(channel, (queue = []));
      const task = { critical, run, resolve };
      const before = critical ? queue.findIndex((item) => !item.critical) : -1;
      if (before < 0) queue.push(task);
      else queue.splice(before, 0, task);
      if (!this.running.has(channel)) this.launch(channel, queue);
    });
  }
  private launch(channel: string, queue: Task[]) {
    const work = Promise.resolve()
      .then(async () => {
        while (queue!.length) {
          const current = queue!.shift()!;
          try {
            current.resolve(await current.run());
          } catch (error) {
            this.failure(error);
            current.resolve();
          } finally {
            this.state.pending--;
          }
        }
      })
      .finally(() => {
        this.running.delete(channel);
        // A caller can enqueue in the microtask between the loop ending and here.
        if (queue.length) this.launch(channel, queue);
        else this.queues.delete(channel);
      });
    this.running.set(channel, work);
  }
  private async destination(guild: string, kind: LogKind, id: string) {
    assert(
      guild === this.app.guildId && this.app.store.config(guild).logs[kind] === id,
      'Log destination changed before delivery; record was not sent.',
    );
    const channel = await textChannel(this.app, guild, id);
    if (sensitive.has(kind)) await privateLogChannel(this.app, channel);
    return channel;
  }
  audit: App['audit'] = async (guild, kind, title, description, options = {}) => {
    const cfg = this.app.store.config(guild);
    if (!cfg.modules.logging && !options.force) return;
    const id = cfg.logs[kind];
    if (!id) return;
    const at = options.at ?? Date.now();
    const presentation = { ...options, at, profile: options.profile ?? systemLogProfile(this.app) };
    const key =
      !options.files?.length &&
      !options.image &&
      !options.controls?.length &&
      !options.reference &&
      description.length < 2500 &&
      /failed|unavailable|could not|needs attention|needs review|not confirmed/i.test(title)
        ? JSON.stringify([guild, kind, title, description, presentation.profile])
        : undefined;
    return this.enqueue(
      id,
      !!options.force || kind === 'moderation' || kind === 'reports' || kind === 'automod',
      async () => {
        const existing = key ? this.warnings.get(key) : undefined;
        if (existing && Date.now() - existing.at < 60000) {
          existing.count++;
          existing.latest = at;
          this.state.grouped++;
          this.save();
          if (!existing.timer) {
            existing.timer = setTimeout(() => {
              existing.timer = undefined;
              void this.refreshWarning(existing);
            }, 10000);
            existing.timer.unref();
          }
          return `https://discord.com/channels/${guild}/${id}/${existing.message}`;
        }
        let first: Message | undefined,
          delivered = 0;
        try {
          for (const payload of logPayloads(kind, title, description, presentation)) {
            const channel = await this.destination(guild, kind, id);
            const message = await channel.send(payload);
            first ??= message;
            delivered++;
            this.app.store.put(guild, 'logMessage', message.id, {
              channel: id,
              created: at,
              kind,
              source: options.source,
            });
          }
          this.state.sent++;
          this.state.lastSent = Date.now();
          this.save();
          if (key && first) {
            if (existing?.timer) {
              clearTimeout(existing.timer);
              await this.refreshWarningNow(existing).catch((error) => this.failure(error));
            }
            const warning: Warning = {
              count: 1,
              printed: 1,
              at,
              latest: at,
              channel: id,
              message: first.id,
              kind,
              title,
              text: description,
              options: presentation,
            };
            this.warnings.set(key, warning);
            for (const [oldKey, old] of this.warnings)
              if (this.warnings.size > 200 && !old.timer) this.warnings.delete(oldKey);
          }
        } catch (error) {
          this.failure(error, delivered > 0);
        }
        // Return the retained first page even if a later page failed.
        return first ? `https://discord.com/channels/${guild}/${id}/${first.id}` : undefined;
      },
    );
  };
  private async refreshWarningNow(warning: Warning) {
    if (warning.count === warning.printed) return;
    const channel = await this.destination(this.app.guildId, warning.kind, warning.channel);
    const message = await channel.messages.fetch(warning.message);
    const [payload] = logPayloads(
      warning.kind,
      warning.title,
      `${warning.text}\n\nRepeated ${warning.count} times · latest <t:${Math.floor(warning.latest / 1000)}:T>.`,
      warning.options,
    );
    await message.edit({ embeds: payload!.embeds, allowedMentions: noMentions });
    warning.printed = warning.count;
  }
  private refreshWarning(warning: Warning) {
    return this.enqueue(warning.channel, true, async () => {
      await this.refreshWarningNow(warning);
    });
  }
  async close() {
    for (const warning of this.warnings.values()) {
      if (warning.timer) clearTimeout(warning.timer);
      warning.timer = undefined;
      if (warning.count !== warning.printed) await this.refreshWarning(warning);
    }
    this.accepting = false;
    while (this.running.size) await Promise.all(this.running.values());
  }
}
