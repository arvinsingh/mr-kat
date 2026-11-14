import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configSchema, defaultConfig, type GuildConfig } from './config.js';

export interface Job {
  id: string;
  guild: string;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  state: 'ready' | 'running' | 'done' | 'failed' | 'cancelled';
  due: number;
  attempts: number;
  error: string | null;
}
export interface Case {
  id: number;
  guild: string;
  actor: string;
  target: string;
  action: string;
  reason: string;
  created: number;
}
export interface Entry<T> {
  key: string;
  data: T;
  updated: number;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings(guild TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries(guild TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(guild,kind,key));
      CREATE TABLE IF NOT EXISTS cases(id INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT NOT NULL, actor TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cases_guild_target ON cases(guild,target,created);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, guild TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,due);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, guild TEXT NOT NULL, channel TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_guild_created ON snapshots(guild,created);
      CREATE TABLE IF NOT EXISTS counters(guild TEXT NOT NULL, day TEXT NOT NULL, metric TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(guild,day,metric));
      INSERT OR IGNORE INTO migrations(version) VALUES(1);`);
    // Retire the staff-readable legacy mapping namespace. No command exposes these links.
    this.db.exec(`INSERT OR IGNORE INTO entries(guild,kind,key,data,updated)
      SELECT guild,'confessionLink',key,data,updated FROM entries WHERE kind='confessionAuthor';
      DELETE FROM entries WHERE kind='confessionAuthor';
      INSERT OR IGNORE INTO migrations(version) VALUES(2);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  config(guild: string): GuildConfig {
    const row = this.db.prepare('SELECT data FROM settings WHERE guild=?').get(guild);
    return row ? configSchema.parse(JSON.parse(String(row.data))) : defaultConfig();
  }
  setConfig(guild: string, value: GuildConfig, actor: string): void {
    const parsed = configSchema.parse(value);
    this.transaction(() => {
      const previous = this.config(guild);
      this.db
        .prepare(
          'INSERT INTO settings VALUES(?,?) ON CONFLICT(guild) DO UPDATE SET data=excluded.data',
        )
        .run(guild, JSON.stringify(parsed));
      this.put(guild, 'configHistory', randomUUID(), { actor, previous, next: parsed });
      if (parsed.snapshotDays === 0 || !parsed.modules.logging)
        this.db.prepare('DELETE FROM snapshots WHERE guild=?').run(guild);
      for (const channel of new Set([
        ...parsed.excludedChannels,
        ...Object.values(parsed.logs).filter((id): id is string => Boolean(id)),
      ]))
        this.db.prepare('DELETE FROM snapshots WHERE guild=? AND channel=?').run(guild, channel);
    });
  }
  get<T>(guild: string, kind: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT data FROM entries WHERE guild=? AND kind=? AND key=?')
      .get(guild, kind, key);
    return row ? (JSON.parse(String(row.data)) as T) : undefined;
  }
  put(guild: string, kind: string, key: string, data: unknown): void {
    this.db
      .prepare(
        'INSERT INTO entries VALUES(?,?,?,?,?) ON CONFLICT(guild,kind,key) DO UPDATE SET data=excluded.data,updated=excluded.updated',
      )
      .run(guild, kind, key, JSON.stringify(data), Date.now());
  }
  delete(guild: string, kind: string, key: string): void {
    this.db.prepare('DELETE FROM entries WHERE guild=? AND kind=? AND key=?').run(guild, kind, key);
  }
  nextSequence(guild: string, name: string): number {
    return this.transaction(() => {
      const value = (this.get<{ value: number }>(guild, 'sequence', name)?.value ?? 0) + 1;
      this.put(guild, 'sequence', name, { value });
      return value;
    });
  }
  entries<T>(guild: string, kind: string, limit = 1000): Entry<T>[] {
    return this.db
      .prepare(
        'SELECT key,data,updated FROM entries WHERE guild=? AND kind=? ORDER BY updated DESC LIMIT ?',
      )
      .all(guild, kind, limit)
      .map((r) => ({
        key: String(r.key),
        data: JSON.parse(String(r.data)) as T,
        updated: Number(r.updated),
      }));
  }
  entriesBefore<T>(guild: string, kind: string, before: number, limit = 100): Entry<T>[] {
    return this.db
      .prepare(
        'SELECT key,data,updated FROM entries WHERE guild=? AND kind=? AND updated<? ORDER BY updated ASC LIMIT ?',
      )
      .all(guild, kind, before, limit)
      .map((r) => ({
        key: String(r.key),
        data: JSON.parse(String(r.data)) as T,
        updated: Number(r.updated),
      }));
  }
  addCase(guild: string, actor: string, target: string, action: string, reason: string): number {
    return Number(
      this.db
        .prepare('INSERT INTO cases(guild,actor,target,action,reason,created) VALUES(?,?,?,?,?,?)')
        .run(guild, actor, target, action, reason, Date.now()).lastInsertRowid,
    );
  }
  cases(guild: string, target?: string, limit = 100): Case[] {
    const rows = target
      ? this.db
          .prepare('SELECT * FROM cases WHERE guild=? AND target=? ORDER BY id DESC LIMIT ?')
          .all(guild, target, limit)
      : this.db
          .prepare('SELECT * FROM cases WHERE guild=? ORDER BY id DESC LIMIT ?')
          .all(guild, limit);
    return rows as unknown as Case[];
  }
  case(guild: string, caseId: number): Case | undefined {
    return this.db
      .prepare('SELECT * FROM cases WHERE guild=? AND id=?')
      .get(guild, caseId) as unknown as Case | undefined;
  }
  warningCases(guild: string, target: string): Case[] {
    return this.db
      .prepare("SELECT * FROM cases WHERE guild=? AND target=? AND action='warn' ORDER BY id DESC")
      .all(guild, target) as unknown as Case[];
  }
  job(
    guild: string,
    actor: string,
    kind: string,
    payload: Record<string, unknown>,
    due = Date.now(),
  ): string {
    const jobId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO jobs(id,guild,actor,kind,payload,state,due) VALUES(?,?,?,?,?,'ready',?)",
      )
      .run(jobId, guild, actor, kind, JSON.stringify(payload), due);
    return jobId;
  }
  jobs(guild: string, limit = 50): Job[] {
    return this.db
      .prepare('SELECT * FROM jobs WHERE guild=? ORDER BY due DESC LIMIT ?')
      .all(guild, limit)
      .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) })) as unknown as Job[];
  }
  findJob(guild: string, jobId: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE guild=? AND id=?').get(guild, jobId);
    return row
      ? ({ ...row, payload: JSON.parse(String(row.payload)) } as unknown as Job)
      : undefined;
  }
  claimJob(now = Date.now()): Job | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE state='ready' AND due<=? ORDER BY due LIMIT 1")
        .get(now);
      if (!row) return undefined;
      this.db
        .prepare("UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=?")
        .run(String(row.id));
      return {
        ...row,
        state: 'running',
        attempts: Number(row.attempts) + 1,
        payload: JSON.parse(String(row.payload)),
      } as unknown as Job;
    });
  }
  updateJob(jobId: string, payload: Record<string, unknown>): void {
    this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(payload), jobId);
  }
  finishJob(jobId: string, state: 'done' | 'failed', error: string | null = null): void {
    this.db
      .prepare("UPDATE jobs SET state=?,error=? WHERE id=? AND state='running'")
      .run(state, error, jobId);
  }
  cancelJob(guild: string, jobId: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET state='cancelled' WHERE guild=? AND id=? AND state IN ('ready','running')",
        )
        .run(guild, jobId).changes > 0
    );
  }
  cancelled(jobId: string): boolean {
    return this.db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)?.state === 'cancelled';
  }
  recoverJobs(): void {
    this.db.prepare("UPDATE jobs SET state='ready' WHERE state='running'").run();
  }
  snapshot(guild: string, channel: string, message: string, author: string, content: string): void {
    this.db
      .prepare(
        'INSERT INTO snapshots VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,created=excluded.created',
      )
      .run(message, guild, channel, author, content, Date.now());
  }
  message(message: string): { content: string; author: string; channel: string } | undefined {
    return this.db
      .prepare('SELECT content,author,channel FROM snapshots WHERE id=?')
      .get(message) as { content: string; author: string; channel: string } | undefined;
  }
  forgetMessage(message: string): void {
    this.db.prepare('DELETE FROM snapshots WHERE id=?').run(message);
  }
  count(guild: string, metric: string, amount = 1): void {
    this.db
      .prepare(
        'INSERT INTO counters VALUES(?,?,?,?) ON CONFLICT(guild,day,metric) DO UPDATE SET value=value+excluded.value',
      )
      .run(guild, new Date().toISOString().slice(0, 10), metric, amount);
  }
  stats(guild: string, days = 30): Record<string, number> {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return Object.fromEntries(
      this.db
        .prepare(
          'SELECT metric,SUM(value) AS value FROM counters WHERE guild=? AND day>=? GROUP BY metric',
        )
        .all(guild, since)
        .map((r) => [String(r.metric), Number(r.value)]),
    );
  }
  prune(guild: string, snapshotDays: number, retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 86400000;
    this.transaction(() => {
      this.db
        .prepare('DELETE FROM snapshots WHERE guild=? AND created<?')
        .run(guild, Date.now() - snapshotDays * 86400000);
      this.db.prepare('DELETE FROM cases WHERE guild=? AND created<?').run(guild, cutoff);
      this.db
        .prepare(
          "DELETE FROM jobs WHERE guild=? AND state IN ('done','failed','cancelled') AND due<?",
        )
        .run(guild, cutoff);
      const retentionKinds = [
        'purgeEvidence',
        'channelSendReceipt',
        'caseEvidence',
        'warningRevocation',
        'warningEscalation',
        'ticketClosure',
        'roleMentionIncident',
        'uwuSource',
        'uwuDraft',
        'uwuPost',
        'uwuPanel',
        'announcementDelivery',
        'commandReceipt',
        'dmReceipt',
        'suggestionAction',
        'confession',
        'confessionAuthor',
        'confessionLink',
        'confessionParticipants',
        'confessionSubscriptions',
        'confessionDelivery',
        'confessionSubmission',
        'onboardingProgress',
        'configHistory',
        'notes',
        'reports',
        'appeals',
        'caseAmendments',
        'activity',
        'roleRestore',
      ];
      for (const kind of retentionKinds)
        this.db
          .prepare('DELETE FROM entries WHERE guild=? AND kind=? AND updated<?')
          .run(guild, kind, cutoff);
      for (const kind of ['confessionLink', 'confessionParticipants', 'confessionSubscriptions'])
        this.db
          .prepare(
            "DELETE FROM entries WHERE guild=? AND kind=? AND NOT EXISTS(SELECT 1 FROM entries AS parent WHERE parent.guild=entries.guild AND parent.kind='confession' AND parent.key=entries.key)",
          )
          .run(guild, kind);
      this.db
        .prepare(
          "DELETE FROM entries WHERE guild=? AND kind='confessionDelivery' AND NOT EXISTS(SELECT 1 FROM entries AS parent WHERE parent.guild=entries.guild AND parent.kind='confession' AND parent.key=CAST(json_extract(entries.data,'$.root') AS TEXT))",
        )
        .run(guild);
      this.db
        .prepare("DELETE FROM entries WHERE guild=? AND kind='confirmation' AND updated<?")
        .run(guild, Date.now() - 600000);
      for (const kind of [
        'reportDraft',
        'moderationDraft',
        'warningPanel',
        'warningForm',
        'approval',
        'voiceCooldown',
        'voiceFailureNotice',
        'ticketCooldown',
        'reportCooldown',
        'suggestCooldown',
        'dmCooldown',
        'stickyPost',
        'purgeDeletion',
      ])
        this.db
          .prepare('DELETE FROM entries WHERE guild=? AND kind=? AND updated<?')
          .run(guild, kind, Date.now() - 86400000);
      this.db
        .prepare(
          "DELETE FROM entries WHERE guild=? AND kind='warningExpiry' AND NOT EXISTS(SELECT 1 FROM cases WHERE cases.guild=entries.guild AND cases.id=CAST(entries.key AS INTEGER))",
        )
        .run(guild);
      this.db
        .prepare(
          "DELETE FROM entries WHERE guild=? AND kind='poll' AND json_extract(data,'$.expires')<?",
        )
        .run(guild, cutoff);
      this.db
        .prepare(
          "DELETE FROM entries WHERE guild=? AND kind='suggestion' AND json_extract(data,'$.state') IN ('declined','implemented') AND updated<?",
        )
        .run(guild, cutoff);
      this.db
        .prepare("DELETE FROM entries WHERE guild=? AND kind='verification' AND updated<?")
        .run(guild, cutoff);
      this.db
        .prepare('DELETE FROM counters WHERE guild=? AND day<?')
        .run(guild, new Date(cutoff).toISOString().slice(0, 10));
    });
  }
  async backup(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await backup(this.db, path);
  }
  close(): void {
    this.db.close();
  }
}
