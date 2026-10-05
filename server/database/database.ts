import sqlite3 from "sqlite3";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { CreateLogger } from "../logging/logger.ts";
import { SCHEMA_SQL } from "./schema.ts";

const log = CreateLogger("database");

export interface RunResult {
  changes: number;
  last_id: number;
}

// One connection; every statement goes through a FIFO gate so an open transaction
// never interleaves with statements from unrelated async work.
export class Database {
  private connection: sqlite3.Database;
  private gate: Promise<unknown> = Promise.resolve();
  private context = new AsyncLocalStorage<boolean>();
  readonly file_path: string;

  private constructor(connection: sqlite3.Database, file_path: string) {
    this.connection = connection;
    this.file_path = file_path;
  }

  static async Open(file_path: string): Promise<Database> {
    if (file_path !== ":memory:") fs.mkdirSync(path.dirname(file_path), { recursive: true });
    const connection = await new Promise<sqlite3.Database>((resolve, reject) => {
      const db = new sqlite3.Database(file_path, (error) => (error ? reject(error) : resolve(db)));
    });
    const database = new Database(connection, file_path);
    await database.RawExec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (file_path !== ":memory:") await database.RawExec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    await database.RawExec(SCHEMA_SQL);
    await database.Migrate();
    log.Info("database opened", { file_path });
    return database;
  }

  // Additive column migrations for databases created by older versions.
  private async Migrate(): Promise<void> {
    const columns = await this.RawAll<{ name: string }>("PRAGMA table_info(users)", []);
    if (!columns.some((column) => column.name === "is_guest")) {
      await this.RawExec("ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0 CHECK (is_guest IN (0, 1))");
    }
  }

  private RawExec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => this.connection.exec(sql, (error) => (error ? reject(error) : resolve())));
  }

  private RawRun(sql: string, params: unknown[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.connection.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve({ changes: this.changes, last_id: this.lastID });
      });
    });
  }

  private RawGet<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    return new Promise((resolve, reject) => this.connection.get(sql, params, (error, row) => (error ? reject(error) : resolve(row as T))));
  }

  private RawAll<T>(sql: string, params: unknown[]): Promise<T[]> {
    return new Promise((resolve, reject) => this.connection.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows as T[]))));
  }

  private Enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    const result = this.gate.then(() => this.context.run(true, work));
    this.gate = result.catch(() => undefined);
    return result;
  }

  Run(sql: string, ...params: unknown[]): Promise<RunResult> {
    return this.Enqueue(() => this.RawRun(sql, params));
  }

  Get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.Enqueue(() => this.RawGet<T>(sql, params));
  }

  All<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.Enqueue(() => this.RawAll<T>(sql, params));
  }

  Exec(sql: string): Promise<void> {
    return this.Enqueue(() => this.RawExec(sql));
  }

  get in_transaction(): boolean {
    return this.context.getStore() === true;
  }

  // Re-entrant: a nested call joins the outer transaction.
  Transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    return this.Enqueue(async () => {
      await this.RawExec("BEGIN IMMEDIATE");
      try {
        const result = await work();
        await this.RawExec("COMMIT");
        return result;
      } catch (error) {
        await this.RawExec("ROLLBACK").catch((rollback_error) => log.Error("rollback failed", { error: String(rollback_error) }));
        throw error;
      }
    });
  }

  Close(): Promise<void> {
    return this.Enqueue(() => new Promise<void>((resolve, reject) => this.connection.close((error) => (error ? reject(error) : resolve()))));
  }
}
