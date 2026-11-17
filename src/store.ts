import { DatabaseSync, backup, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configSchema, defaultConfig, type GuildConfig } from './config.js';
import { assert } from './util.js';
import { schemaVersion } from './database-schema.js';

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
  private readonly statements = new Map<string, StatementSync>();
  private readonly configs = new Map<
    string,
    { revision: number; data?: string; value: GuildConfig }
  >();
  private readonly configBases = new WeakMap<GuildConfig, { guild: string; revision: number }>();
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.initialize();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private initialize(): void {
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
    assert(
      Number(this.statement('SELECT MAX(version) AS version FROM migrations').get()!.version) <=
        schemaVersion,
      'The database schema is newer than this bot version. Use a compatible release.',
    );
    if (!this.statement('SELECT 1 FROM migrations WHERE version=2').get())
      this.transaction(() => {
        // Retire the staff-readable namespace once, preserving legacy backup upgrades.
        this.db.exec(`INSERT OR IGNORE INTO entries(guild,kind,key,data,updated)
          SELECT guild,'confessionLink',key,data,updated FROM entries WHERE kind='confessionAuthor';
          DELETE FROM entries WHERE kind='confessionAuthor';
          INSERT INTO migrations(version) VALUES(2);`);
      });
    if (!this.statement('SELECT 1 FROM migrations WHERE version=3').get())
      this.transaction(() => {
        // Keep the two-column settings table compatible with previous runtime releases.
        this.db
          .exec(`CREATE TABLE settings_revisions(guild TEXT PRIMARY KEY,revision INTEGER NOT NULL);
          CREATE INDEX entries_updated ON entries(guild,kind,updated);
          CREATE INDEX cases_warning ON cases(guild,target,action,id DESC);
          CREATE INDEX cases_guild_id ON cases(guild,id DESC);
          CREATE INDEX jobs_guild_due ON jobs(guild,due DESC);
          CREATE INDEX jobs_actor_due ON jobs(guild,actor,due DESC);
          INSERT INTO migrations(version) VALUES(3);`);
      });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.configs.clear();
      throw error;
    }
  }
  config(guild: string): GuildConfig {
    const row = this.statement(
      'SELECT s.data,COALESCE(r.revision,0) AS revision FROM settings AS s LEFT JOIN settings_revisions AS r ON r.guild=s.guild WHERE s.guild=?',
    ).get(guild);
    const revision = Number(row?.revision ?? 0);
    const data = row ? String(row.data) : undefined;
    let cached = this.configs.get(guild);
    if (!cached || cached.revision !== revision || cached.data !== data) {
      cached = {
        revision,
        data,
        value: data !== undefined ? configSchema.parse(JSON.parse(data)) : defaultConfig(),
      };
      this.configs.set(guild, cached);
    }
    const value = structuredClone(cached.value);
    this.configBases.set(value, { guild, revision });
    return value;
  }
  configRevision(guild: string): number {
    return Number(
      this.statement('SELECT revision FROM settings_revisions WHERE guild=?').get(guild)
        ?.revision ?? 0,
    );
  }
  setConfig(guild: string, value: GuildConfig, actor: string, expectedRevision?: number): void {
    const parsed = configSchema.parse(value);
    const base = this.configBases.get(value);
    const expected = expectedRevision ?? (base?.guild === guild ? base.revision : undefined);
    this.transaction(() => {
      assert(
        expected === undefined || this.configRevision(guild) === expected,
        'Settings changed while this action was open. Reload the settings and try again.',
      );
      const previous = this.config(guild);
      this.statement(
        'INSERT INTO settings(guild,data) VALUES(?,?) ON CONFLICT(guild) DO UPDATE SET data=excluded.data',
      ).run(guild, JSON.stringify(parsed));
      this.statement(
        'INSERT INTO settings_revisions VALUES(?,1) ON CONFLICT(guild) DO UPDATE SET revision=revision+1',
      ).run(guild);
      this.put(guild, 'configHistory', randomUUID(), { actor, previous, next: parsed });
      if (parsed.snapshotDays === 0 || !parsed.modules.logging)
        this.statement('DELETE FROM snapshots WHERE guild=?').run(guild);
      for (const channel of new Set([
        ...parsed.excludedChannels,
        ...Object.values(parsed.logs).filter((id): id is string => Boolean(id)),
      ]))
        this.statement('DELETE FROM snapshots WHERE guild=? AND channel=?').run(guild, channel);
    });
    this.configs.delete(guild);
    this.configBases.set(value, { guild, revision: this.configRevision(guild) });
  }
  get<T>(guild: string, kind: string, key: string): T | undefined {
    const row = this.statement('SELECT data FROM entries WHERE guild=? AND kind=? AND key=?').get(
      guild,
      kind,
      key,
    );
    return row ? (JSON.parse(String(row.data)) as T) : undefined;
  }
  put(guild: string, kind: string, key: string, data: unknown): void {
    this.statement(
      'INSERT INTO entries VALUES(?,?,?,?,?) ON CONFLICT(guild,kind,key) DO UPDATE SET data=excluded.data,updated=excluded.updated',
    ).run(guild, kind, key, JSON.stringify(data), Date.now());
  }
  delete(guild: string, kind: string, key: string): void {
    this.statement('DELETE FROM entries WHERE guild=? AND kind=? AND key=?').run(guild, kind, key);
  }
  nextSequence(guild: string, name: string): number {
    return this.transaction(() => {
      const value = (this.get<{ value: number }>(guild, 'sequence', name)?.value ?? 0) + 1;
      this.put(guild, 'sequence', name, { value });
      return value;
    });
  }
  entries<T>(guild: string, kind: string, limit = 1000): Entry<T>[] {
    return this.statement(
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
    return this.statement(
      'SELECT key,data,updated FROM entries WHERE guild=? AND kind=? AND updated<? ORDER BY updated ASC LIMIT ?',
    )
      .all(guild, kind, before, limit)
      .map((r) => ({
        key: String(r.key),
        data: JSON.parse(String(r.data)) as T,
        updated: Number(r.updated),
      }));
  }
  // Filter before LIMIT so older unresolved work cannot be hidden by newer records.
  entriesMatching<T>(
    guild: string,
    kind: string,
    filters: Record<string, string | number | boolean>,
    limit = 100,
  ): Entry<T>[] {
    return this.statement(
      `SELECT key,data,updated FROM entries
      WHERE guild=? AND kind=? AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS filter
        WHERE json_extract(entries.data,'$.' || filter.key) IS NOT filter.value
      ) ORDER BY updated DESC LIMIT ?`,
    )
      .all(guild, kind, JSON.stringify(filters), limit)
      .map((row) => ({
        key: String(row.key),
        data: JSON.parse(String(row.data)) as T,
        updated: Number(row.updated),
      }));
  }
  inactiveMembers(guild: string, before: number, limit = 30): Entry<{ last: number }>[] {
    return this.statement(
      "SELECT key,data,updated FROM entries WHERE guild=? AND kind='activity' AND json_extract(data,'$.last')<? ORDER BY updated ASC LIMIT ?",
    )
      .all(guild, before, limit)
      .map((row) => ({
        key: String(row.key),
        data: JSON.parse(String(row.data)),
        updated: Number(row.updated),
      }));
  }
  activePolls(guild: string, now = Date.now()): number {
    return Number(
      this.statement(
        "SELECT COUNT(*) AS n FROM entries WHERE guild=? AND kind='poll' AND json_extract(data,'$.closed')=0 AND json_extract(data,'$.expires')>?",
      ).get(guild, now)!.n,
    );
  }
  pendingConfessions(guild: string): number {
    return Number(
      this.statement(
        "SELECT COUNT(*) AS n FROM entries WHERE guild=? AND kind='confession' AND json_extract(data,'$.state') IN ('pending','review_failed','publishing','uncertain')",
      ).get(guild)!.n,
    );
  }
  addCase(guild: string, actor: string, target: string, action: string, reason: string): number {
    return Number(
      this.statement(
        'INSERT INTO cases(guild,actor,target,action,reason,created) VALUES(?,?,?,?,?,?)',
      ).run(guild, actor, target, action, reason, Date.now()).lastInsertRowid,
    );
  }
  cases(guild: string, target?: string, limit = 100): Case[] {
    const rows = target
      ? this.statement(
          'SELECT * FROM cases WHERE guild=? AND target=? ORDER BY id DESC LIMIT ?',
        ).all(guild, target, limit)
      : this.statement('SELECT * FROM cases WHERE guild=? ORDER BY id DESC LIMIT ?').all(
          guild,
          limit,
        );
    return rows as unknown as Case[];
  }
  case(guild: string, caseId: number): Case | undefined {
    return this.statement('SELECT * FROM cases WHERE guild=? AND id=?').get(
      guild,
      caseId,
    ) as unknown as Case | undefined;
  }
  caseAmendments<T>(guild: string, cases: number[]): Entry<T>[] {
    return this.statement(
      "SELECT key,data,updated FROM entries WHERE guild=? AND kind='caseAmendments' AND json_extract(data,'$.caseId') IN (SELECT value FROM json_each(?)) ORDER BY updated DESC",
    )
      .all(guild, JSON.stringify(cases))
      .map((row) => ({
        key: String(row.key),
        data: JSON.parse(String(row.data)) as T,
        updated: Number(row.updated),
      }));
  }
  staffCaseCounts(
    guild: string,
    limit = 1000,
  ): { total: number; actors: { actor: string; count: number }[] } {
    const rows = this.statement(
      'SELECT actor,COUNT(*) AS n FROM (SELECT actor,id FROM cases WHERE guild=? ORDER BY id DESC LIMIT ?) GROUP BY actor ORDER BY MAX(id) DESC',
    ).all(guild, limit);
    const actors = rows.map((row) => ({ actor: String(row.actor), count: Number(row.n) }));
    return { total: actors.reduce((total, row) => total + row.count, 0), actors };
  }
  warningCases<T>(guild: string, target: string): (Case & { revoked?: T; expires?: number })[] {
    return this.statement(
      `SELECT c.*, r.data AS revocation, e.data AS expiry FROM cases AS c
      LEFT JOIN entries AS r ON r.guild=c.guild AND r.kind='warningRevocation' AND r.key=CAST(c.id AS TEXT)
      LEFT JOIN entries AS e ON e.guild=c.guild AND e.kind='warningExpiry' AND e.key=CAST(c.id AS TEXT)
      WHERE c.guild=? AND c.target=? AND c.action='warn' ORDER BY c.id DESC`,
    )
      .all(guild, target)
      .map(({ revocation, expiry, ...row }) => ({
        ...row,
        revoked: revocation ? (JSON.parse(String(revocation)) as T) : undefined,
        expires: expiry ? (JSON.parse(String(expiry)).expires as number) : undefined,
      })) as unknown as (Case & { revoked?: T; expires?: number })[];
  }
  job(
    guild: string,
    actor: string,
    kind: string,
    payload: Record<string, unknown>,
    due = Date.now(),
  ): string {
    const jobId = randomUUID();
    this.statement(
      "INSERT INTO jobs(id,guild,actor,kind,payload,state,due) VALUES(?,?,?,?,?,'ready',?)",
    ).run(jobId, guild, actor, kind, JSON.stringify(payload), due);
    return jobId;
  }
  jobs(guild: string, limit = 50, actor?: string): Job[] {
    const rows =
      actor === undefined
        ? this.statement('SELECT * FROM jobs WHERE guild=? ORDER BY due DESC LIMIT ?').all(
            guild,
            limit,
          )
        : this.statement(
            'SELECT * FROM jobs WHERE guild=? AND actor=? ORDER BY due DESC LIMIT ?',
          ).all(guild, actor, limit);
    return rows.map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) })) as unknown as Job[];
  }
  pendingReminders(guild: string, actor: string): number {
    return Number(
      this.statement(
        "SELECT COUNT(*) AS n FROM jobs WHERE guild=? AND actor=? AND kind='reminder' AND state IN ('ready','running')",
      ).get(guild, actor)!.n,
    );
  }
  findJob(guild: string, jobId: string): Job | undefined {
    const row = this.statement('SELECT * FROM jobs WHERE guild=? AND id=?').get(guild, jobId);
    return row
      ? ({ ...row, payload: JSON.parse(String(row.payload)) } as unknown as Job)
      : undefined;
  }
  claimJob(now = Date.now(), lane?: 'notifications' | 'operations'): Job | undefined {
    return this.transaction(() => {
      // Only notification jobs run alongside operations. Role/ban/channel mutations stay serialized.
      const clause =
        lane === undefined
          ? ''
          : lane === 'notifications'
            ? " AND kind IN ('reminder','pollClose','announce')"
            : " AND kind NOT IN ('reminder','pollClose','announce')";
      const row = this.statement(
        `SELECT * FROM jobs WHERE state='ready' AND due<=?${clause} ORDER BY due LIMIT 1`,
      ).get(now);
      if (!row) return undefined;
      this.statement("UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=?").run(
        String(row.id),
      );
      return {
        ...row,
        state: 'running',
        attempts: Number(row.attempts) + 1,
        payload: JSON.parse(String(row.payload)),
      } as unknown as Job;
    });
  }
  updateJob(jobId: string, payload: Record<string, unknown>): void {
    this.statement('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(payload), jobId);
  }
  finishJob(jobId: string, state: 'done' | 'failed', error: string | null = null): void {
    this.statement("UPDATE jobs SET state=?,error=? WHERE id=? AND state='running'").run(
      state,
      error,
      jobId,
    );
  }
  cancelJob(guild: string, jobId: string): boolean {
    return (
      this.statement(
        "UPDATE jobs SET state='cancelled' WHERE guild=? AND id=? AND state IN ('ready','running')",
      ).run(guild, jobId).changes > 0
    );
  }
  cancelled(jobId: string): boolean {
    return this.statement('SELECT state FROM jobs WHERE id=?').get(jobId)?.state === 'cancelled';
  }
  recoverJobs(): void {
    this.statement("UPDATE jobs SET state='ready' WHERE state='running'").run();
  }
  snapshot(guild: string, channel: string, message: string, author: string, content: string): void {
    this.statement(
      'INSERT INTO snapshots VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,created=excluded.created',
    ).run(message, guild, channel, author, content, Date.now());
  }
  message(message: string): { content: string; author: string; channel: string } | undefined {
    return this.statement('SELECT content,author,channel FROM snapshots WHERE id=?').get(
      message,
    ) as { content: string; author: string; channel: string } | undefined;
  }
  forgetMessage(message: string): void {
    this.statement('DELETE FROM snapshots WHERE id=?').run(message);
  }
  count(guild: string, metric: string, amount = 1): void {
    this.statement(
      'INSERT INTO counters VALUES(?,?,?,?) ON CONFLICT(guild,day,metric) DO UPDATE SET value=value+excluded.value',
    ).run(guild, new Date().toISOString().slice(0, 10), metric, amount);
  }
  stats(guild: string, days = 30): Record<string, number> {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return Object.fromEntries(
      this.statement(
        'SELECT metric,SUM(value) AS value FROM counters WHERE guild=? AND day>=? GROUP BY metric',
      )
        .all(guild, since)
        .map((r) => [String(r.metric), Number(r.value)]),
    );
  }
  prune(guild: string, snapshotDays: number, retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 86400000;
    this.transaction(() => {
      this.statement('DELETE FROM snapshots WHERE guild=? AND created<?').run(
        guild,
        Date.now() - snapshotDays * 86400000,
      );
      this.statement('DELETE FROM cases WHERE guild=? AND created<?').run(guild, cutoff);
      this.statement(
        "DELETE FROM jobs WHERE guild=? AND state IN ('done','failed','cancelled') AND due<?",
      ).run(guild, cutoff);
      // Keep review/release controls until the timeout ends and all cleanup jobs settle.
      this.statement(
        `DELETE FROM entries WHERE guild=? AND kind='honeypotIncident' AND updated<?
        AND (json_extract(data,'$.released')=1 OR json_extract(data,'$.timeoutUntil')<?)
        AND NOT EXISTS(SELECT 1 FROM jobs WHERE jobs.guild=entries.guild AND jobs.state IN ('ready','running')
          AND ((jobs.kind='honeypotCleanup' AND json_extract(jobs.payload,'$.incident')=entries.key)
            OR (jobs.kind='honeypotPurge' AND json_extract(jobs.payload,'$.honeypot')=entries.key)))`,
      ).run(guild, cutoff, Date.now());
      this.statement(
        `DELETE FROM entries WHERE guild=? AND kind='honeypotActive'
        AND (json_extract(data,'$.until')<? OR NOT EXISTS(SELECT 1 FROM entries AS incident
          WHERE incident.guild=entries.guild AND incident.kind='honeypotIncident' AND incident.key=json_extract(entries.data,'$.incident')))`,
      ).run(guild, Date.now());
      const retentionKinds = [
        'purgeEvidence',
        'caseLog',
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
        'roastReceipt',
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
        this.statement('DELETE FROM entries WHERE guild=? AND kind=? AND updated<?').run(
          guild,
          kind,
          cutoff,
        );
      for (const kind of ['confessionLink', 'confessionParticipants', 'confessionSubscriptions'])
        this.statement(
          "DELETE FROM entries WHERE guild=? AND kind=? AND NOT EXISTS(SELECT 1 FROM entries AS parent WHERE parent.guild=entries.guild AND parent.kind='confession' AND parent.key=entries.key)",
        ).run(guild, kind);
      this.statement(
        "DELETE FROM entries WHERE guild=? AND kind='confessionDelivery' AND NOT EXISTS(SELECT 1 FROM entries AS parent WHERE parent.guild=entries.guild AND parent.kind='confession' AND parent.key=CAST(json_extract(entries.data,'$.root') AS TEXT))",
      ).run(guild);
      this.statement("DELETE FROM entries WHERE guild=? AND kind='confirmation' AND updated<?").run(
        guild,
        Date.now() - 600000,
      );
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
        'roastRecent',
        'roastPanel',
        'purgeDeletion',
        'moderationEvent',
      ])
        this.statement('DELETE FROM entries WHERE guild=? AND kind=? AND updated<?').run(
          guild,
          kind,
          Date.now() - 86400000,
        );
      this.statement(
        "DELETE FROM entries WHERE guild=? AND kind='warningExpiry' AND NOT EXISTS(SELECT 1 FROM cases WHERE cases.guild=entries.guild AND cases.id=CAST(entries.key AS INTEGER))",
      ).run(guild);
      this.statement(
        "DELETE FROM entries WHERE guild=? AND kind='poll' AND json_extract(data,'$.expires')<?",
      ).run(guild, cutoff);
      this.statement(
        "DELETE FROM entries WHERE guild=? AND kind='suggestion' AND json_extract(data,'$.state') IN ('declined','implemented') AND updated<?",
      ).run(guild, cutoff);
      this.statement(
        "DELETE FROM entries WHERE guild=? AND kind='roastSubmission' AND json_extract(data,'$.status')='rejected' AND updated<?",
      ).run(guild, cutoff);
      this.statement("DELETE FROM entries WHERE guild=? AND kind='verification' AND updated<?").run(
        guild,
        cutoff,
      );
      this.statement('DELETE FROM counters WHERE guild=? AND day<?').run(
        guild,
        new Date(cutoff).toISOString().slice(0, 10),
      );
    });
  }
  async backup(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await backup(this.db, path);
  }
  close(): void {
    this.configs.clear();
    this.statements.clear();
    this.db.close();
  }
}
