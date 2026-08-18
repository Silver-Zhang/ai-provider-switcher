/**
 * Unified Codex session history (mirrors cc-switch's "统一 Codex 会话历史").
 *
 * Codex buckets its resume/history list by the `model_provider` tag recorded in
 * each session: the official subscription falls into the built-in `openai`
 * bucket while managed relays use their own ids, so the two drawers cannot see
 * each other. This module implements a shared `custom` bucket:
 *
 *  - Official runs under the shared `custom` provider id (auth still goes
 *    through the ChatGPT login in auth.json via `requires_openai_auth`).
 *  - Session tags are migrated between buckets by rewriting ONLY the
 *    `model_provider` field in `~/.codex/sessions/**\/*.jsonl` /
 *    `archived_sessions/**` and the `threads.model_provider` column of the
 *    Codex state DB (`state_5.sqlite` / `state.db`).
 *  - Every rewrite is preceded by a full-file backup under
 *    `<codexDir>/ai-provider-switcher-backups/`, so disabling the feature can
 *    restore migrated official sessions precisely from the backup ledger.
 *
 * Known upstream limitation: resuming an old session on a different provider
 * may fail because `encrypted_content` reasoning can only be decrypted by the
 * backend that produced it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import initSqlJs = require("sql.js");
import { parseTomlTableKeyPath } from "./codexConfig";

export const CODEX_OFFICIAL_PROVIDER_ID = "openai";
export const CODEX_UNIFIED_PROVIDER_ID = "custom";
export const CODEX_UNIFY_BACKUP_NAME = "codex-official-history-unify-v1";
export const CODEX_UNIFY_RESTORE_BACKUP_NAME = "codex-official-history-unify-restore-v1";

const CODEX_STATE_DB_NAMES = ["state_5.sqlite", "state.db"];
const SESSION_DIR_MAX_DEPTH = 8;
const ARCHIVED_DIR_MAX_DEPTH = 4;
const LEDGER_JSONL_MAX_DEPTH = 10;
const LEDGER_STATE_MAX_DEPTH = 4;
const STATE_DB_ID_CHUNK = 500;
const DEFAULT_WAL_WAIT_MS = 8000;

/**
 * A single file or database that could not be processed. Failures are collected
 * per item instead of aborting the run, so one locked rollout file cannot strand
 * the whole history in a half-migrated state.
 */
export type CodexUnifyFailure = {
  /** Absolute path of the jsonl file or state DB that failed. */
  path: string;
  message: string;
};

export type CodexUnifyMigrationOutcome = {
  migratedJsonlFiles: number;
  migratedStateRows: number;
  failures: CodexUnifyFailure[];
  skippedReason?: string;
};

export type CodexUnifyRestoreOutcome = {
  restoredJsonlFiles: number;
  restoredStateRows: number;
  failures: CodexUnifyFailure[];
  skippedReason?: string;
};

export type CodexUnifyMigrationOptions = {
  codexDir: string;
  configText: string;
  /** Provider ids whose sessions were recorded before the shared bucket. */
  thirdPartyTagIds: string[];
  backupParent: string;
  now?: Date;
  /** How long the sql.js fallback waits for the WAL sidecar to clear (ms). */
  walWaitMs?: number;
};

export type CodexUnifyRestoreOptions = {
  codexDir: string;
  backupParent: string;
  restoreBackupParent: string;
  now?: Date;
  /** How long the sql.js fallback waits for the WAL sidecar to clear (ms). */
  walWaitMs?: number;
};

let sqlJsPromise: Promise<initSqlJs.SqlJsStatic> | undefined;

function getSqlJs(): Promise<initSqlJs.SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs();
  }
  return sqlJsPromise;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatUnifyTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function canonicalCodexDirKey(codexDir: string): string {
  try {
    return fs.realpathSync(codexDir);
  } catch {
    return path.resolve(codexDir);
  }
}

function relativeBackupPath(sourcePath: string, codexDir: string): string {
  const relative = path.relative(codexDir, sourcePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return `external-${path.basename(sourcePath)}`;
  }
  return relative;
}

function backupJsonlFileSync(sourcePath: string, codexDir: string, backupRoot: string): void {
  const dest = path.join(backupRoot, "jsonl", relativeBackupPath(sourcePath, codexDir));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(sourcePath, dest);
}

/**
 * Backs the state DB up through the open driver rather than copying the file.
 * A bare copy of a WAL-mode database silently omits everything still sitting in
 * the `-wal` sidecar, which would leave those threads out of the restore ledger
 * and strand them in the shared bucket forever.
 */
function backupStateDbFileSync(
  driver: StateDbDriver,
  sourcePath: string,
  codexDir: string,
  backupRoot: string
): void {
  const dest = path.join(backupRoot, "state", relativeBackupPath(sourcePath, codexDir));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  driver.snapshot(dest);
}

/**
 * Renaming over a file another process holds open fails in opposite ways per platform:
 * Windows refuses with a sharing violation, while POSIX succeeds and orphans the
 * writer's descriptor. The callers guard the POSIX side by verifying the file is
 * unchanged around the read/backup (and, for the state DB, by waiting out the WAL);
 * what was missing was making the Windows refusal legible instead of a bare errno.
 * The rename itself stays atomic so a crash mid-write can never truncate the original.
 */
function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
  const temp = `${filePath}.ai-provider-switcher-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temp, data);
  try {
    fs.renameSync(temp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Best effort cleanup.
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
      // Windows reports a sharing violation as a bare errno, which reads as a
      // permissions problem the user cannot act on.
      throw new Error(
        `无法写入 ${path.basename(filePath)}：文件正被其他程序占用。` +
          `请退出所有正在运行的 Codex（含 VS Code 内的 Codex 面板与终端里的 codex 命令）后重试。`
      );
    }
    throw error;
  }
}

function ensureFileUnchangedSync(filePath: string, mtimeMs: number, size: number): void {
  const stat = fs.statSync(filePath);
  if (stat.mtimeMs !== mtimeMs || stat.size !== size) {
    throw new Error(`文件在迁移期间被其他进程修改，已安全中止：${filePath}`);
  }
}

function writeBackupGenerationMeta(backupRoot: string, codexDirKey: string): void {
  fs.writeFileSync(
    path.join(backupRoot, "meta.json"),
    `${JSON.stringify({ codexConfigDir: codexDirKey }, null, 2)}\n`,
    "utf8"
  );
}

function backupGenerationMatchesDir(generationPath: string, codexDirKey: string): boolean {
  try {
    const text = fs.readFileSync(path.join(generationPath, "meta.json"), "utf8");
    const parsed = JSON.parse(text) as { codexConfigDir?: unknown };
    return typeof parsed.codexConfigDir !== "string" || parsed.codexConfigDir === codexDirKey;
  } catch {
    // Legacy generations without meta.json predate the dir binding; accept them.
    return true;
  }
}

// ---------------------------------------------------------------------------
// config.toml helpers
// ---------------------------------------------------------------------------

/**
 * Whether the live config routes sessions into the shared `custom` bucket.
 * Reads with the lenient scalar parser: TOML accepts `model_provider = 'custom'`
 * just as happily as the double-quoted form, and treating the literal-string form
 * as "not unified" made the extension rewrite a config that was already correct.
 */
export function codexConfigRoutesUnified(configText: string): boolean {
  return parseCodexTopLevelScalar(configText, "model_provider") === CODEX_UNIFIED_PROVIDER_ID;
}

/** Simple top-level scalar parser tolerating both "..." and '...' quoting. */
export function parseCodexTopLevelScalar(content: string, key: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable >= 0 ? firstTable : lines.length;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*?)\\s*$`);
  for (let index = 0; index < end; index += 1) {
    const match = lines[index].match(pattern);
    if (!match) continue;
    let value = match[1];
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      if (match[1].startsWith("\"")) {
        value = value.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
      }
    }
    return value;
  }
  return undefined;
}

function keyPathStartsWith(keyPath: string[], prefix: string[]): boolean {
  return keyPath.length >= prefix.length && prefix.every((part, index) => keyPath[index] === part);
}

/**
 * Locate a table by its parsed key path rather than by matching the header text.
 * `[model_providers.custom]` and `[model_providers."custom"]` are the same table
 * to TOML — and the quoted form is exactly what this extension writes elsewhere,
 * so a text match missed the sections users are most likely to already have.
 */
function findTomlSectionBounds(content: string, sectionName: string): { start: number; end: number } | undefined {
  const target = sectionName.split(".");
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const keyPath = parseTomlTableKeyPath(line);
    return keyPath !== undefined && keyPath.length === target.length && keyPathStartsWith(keyPath, target);
  });
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  return { start, end: end >= 0 ? end : lines.length };
}

function readTomlSectionKeyValues(content: string, sectionName: string): Map<string, string> | undefined {
  const bounds = findTomlSectionBounds(content, sectionName);
  if (!bounds) return undefined;
  const lines = content.split(/\r?\n/);
  const values = new Map<string, string>();
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

/**
 * Whether content already defines the `custom` provider in any form. A subtable such as
 * `[model_providers.custom.auth]` defines the parent table implicitly, so it counts too —
 * appending another `[model_providers.custom]` alongside one is a duplicate-table error
 * that stops Codex from starting.
 */
export function hasCodexCustomProviderSection(content: string): boolean {
  const target = ["model_providers", "custom"];
  return content.split(/\r?\n/).some((line) => {
    const keyPath = parseTomlTableKeyPath(line);
    return keyPath !== undefined && keyPathStartsWith(keyPath, target);
  });
}

/** Whether the existing custom section is exactly the injected official shape. */
export function codexCustomSectionMatchesUnifiedOfficial(content: string): boolean {
  const values = readTomlSectionKeyValues(content, "model_providers.custom");
  if (!values || values.size !== 4) return false;
  return (
    values.get("name") === "\"OpenAI\"" &&
    values.get("requires_openai_auth") === "true" &&
    values.get("supports_websockets") === "true" &&
    values.get("wire_api") === "\"responses\""
  );
}

/**
 * The official `custom` block: `requires_openai_auth` keeps authentication on
 * the ChatGPT login in auth.json (base_url defaults back to the official
 * backend), `name = "OpenAI"` keeps Codex's is_openai() feature gates,
 * `supports_websockets` restores the built-in default, and `wire_api` keeps the
 * official responses protocol. Net effect: auth unchanged, bucket name changed.
 */
export function serializeCodexUnifiedOfficialBlock(): string {
  return [
    "[model_providers.custom]",
    "name = \"OpenAI\"",
    "requires_openai_auth = true",
    "supports_websockets = true",
    "wire_api = \"responses\""
  ].join("\n");
}

/** A `custom` block mirroring the active managed relay provider. */
export function serializeCodexUnifiedProviderBlock(
  provider: { name: string; baseUrl: string },
  auth: { command: string; args: string[] }
): string {
  return [
    "[model_providers.custom]",
    `name = ${JSON.stringify(provider.name)}`,
    `base_url = ${JSON.stringify(provider.baseUrl)}`,
    "wire_api = \"responses\"",
    "",
    "[model_providers.custom.auth]",
    `command = ${JSON.stringify(auth.command)}`,
    `args = [${auth.args.map((argument) => JSON.stringify(argument)).join(", ")}]`
  ].join("\n");
}

// ---------------------------------------------------------------------------
// State DB discovery
// ---------------------------------------------------------------------------

export function getCodexStateDbCandidates(codexDir: string, configText: string): string[] {
  const dirs = [codexDir];
  const sqliteHome = (
    parseCodexTopLevelScalar(configText, "sqlite_home") ||
    process.env.CODEX_SQLITE_HOME ||
    ""
  ).trim();
  // `~/codex-state` is the form people actually write, and a relative path means
  // "relative to the Codex home" — resolving it against the extension host's cwd
  // pointed at whatever directory VS Code happened to be launched from.
  if (sqliteHome) {
    const home = os.homedir();
    const expanded = sqliteHome === "~" || sqliteHome.startsWith("~/") || sqliteHome.startsWith("~\\")
      ? path.join(home, sqliteHome.slice(1))
      : sqliteHome;
    dirs.push(path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(codexDir, expanded));
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of CODEX_STATE_DB_NAMES) {
      const candidate = path.join(dir, name);
      const key = candidate.toLowerCase();
      if (fs.existsSync(candidate) && !seen.has(key)) {
        seen.add(key);
        result.push(candidate);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Session jsonl helpers
// ---------------------------------------------------------------------------

function collectJsonlFilesRecursive(dir: string, files: string[], depth: number, maxDepth: number): void {
  if (depth > maxDepth || !fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFilesRecursive(full, files, depth + 1, maxDepth);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
}

export function collectCodexJsonlFiles(codexDir: string): string[] {
  const files: string[] = [];
  collectJsonlFilesRecursive(path.join(codexDir, "sessions"), files, 0, SESSION_DIR_MAX_DEPTH);
  collectJsonlFilesRecursive(path.join(codexDir, "archived_sessions"), files, 0, ARCHIVED_DIR_MAX_DEPTH);
  files.sort();
  return files;
}

type SessionMeta = { sessionId: string; provider: string };

function parseSessionMetaTag(line: string): SessionMeta | undefined {
  if (!line.includes("\"session_meta\"") || !line.includes("\"model_provider\"")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== "session_meta") return undefined;
  const payload = record.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const provider = (payload as Record<string, unknown>).model_provider;
  const sessionId = (payload as Record<string, unknown>).id;
  if (typeof provider !== "string" || !provider.trim()) return undefined;
  if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
  return { sessionId, provider };
}

function rewriteSessionMetaLine(
  line: string,
  nextTag: (provider: string, sessionId: string) => string | undefined
): string | undefined {
  const meta = parseSessionMetaTag(line);
  if (!meta) return undefined;
  const next = nextTag(meta.provider, meta.sessionId);
  if (!next || next === meta.provider) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  (value as { payload: Record<string, unknown> }).payload.model_provider = next;
  return JSON.stringify(value);
}

/**
 * Rewrites only `session_meta.model_provider` lines. Returns true when the file
 * changed. The original file is backed up (preserving its relative path) before
 * the atomic rewrite; the file is verified unchanged around the backup.
 */
function rewriteCodexJsonlFile(
  filePath: string,
  codexDir: string,
  rewrite: (provider: string, sessionId: string) => string | undefined,
  backupRoot: string
): boolean {
  const before = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);

  let changed = false;
  const nextLines = lines.map((line) => {
    const next = rewriteSessionMetaLine(line, rewrite);
    if (next === undefined) return line;
    changed = true;
    return next;
  });
  if (!changed) return false;

  ensureFileUnchangedSync(filePath, before.mtimeMs, before.size);
  backupJsonlFileSync(filePath, codexDir, backupRoot);
  ensureFileUnchangedSync(filePath, before.mtimeMs, before.size);
  atomicWriteFileSync(filePath, nextLines.join(eol));
  return true;
}

// ---------------------------------------------------------------------------
// State DB access
//
// Prefers Node's built-in `node:sqlite` (Node 22.5+, present in modern VS Code):
// it opens a real SQLite connection that participates in the file-locking /
// WAL protocol, so the state DB can be migrated while Codex keeps it open.
// Falls back to sql.js (in-memory rewrite) with a WAL wait-and-guard.
// ---------------------------------------------------------------------------

type SqlValue = string | number | Uint8Array | null;

type StateDbDriver = {
  allObjects(sql: string, params: SqlValue[]): Array<Record<string, SqlValue>>;
  /** Runs a statement and reports how many rows it actually changed. */
  run(sql: string, params: SqlValue[]): number;
  exec(sql: string): void;
  /**
   * Writes a consistent snapshot of the whole database — including anything
   * still pending in the WAL — to `destPath`. Throws rather than producing an
   * incomplete backup, so a failed snapshot always aborts before any rewrite.
   */
  snapshot(destPath: string): void;
  /** Persist in-memory changes to the file (sql.js only; native is a no-op). */
  flush(): void;
  close(): void;
};

type NativeSqliteOptions = { readOnly?: boolean };

type NativeSqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: SqlValue[]): Array<Record<string, unknown>>;
    run(...params: SqlValue[]): { changes?: number | bigint } | undefined;
  };
  close(): void;
};

let nativeSqliteOverride: boolean | undefined;

/** Test hook: force the sql.js fallback path (undefined restores auto-detection). */
export function overrideNativeSqliteForTests(available: boolean | undefined): void {
  nativeSqliteOverride = available;
}

function loadNativeSqlite():
  | { DatabaseSync: new (path: string, options?: NativeSqliteOptions) => NativeSqliteDatabase }
  | undefined {
  if (nativeSqliteOverride === false) return undefined;
  try {
    const mod = require("node:sqlite") as {
      DatabaseSync?: new (path: string, options?: NativeSqliteOptions) => NativeSqliteDatabase;
    };
    if (typeof mod?.DatabaseSync !== "function") return undefined;
    return { DatabaseSync: mod.DatabaseSync };
  } catch {
    return undefined;
  }
}

/** Quotes a path for use as a SQLite string literal (`VACUUM INTO`). */
function quoteSqliteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function tryOpenNativeStateDb(dbPath: string, readOnly: boolean): StateDbDriver | undefined {
  const loader = loadNativeSqlite();
  if (!loader) return undefined;
  let db: NativeSqliteDatabase | undefined;
  try {
    db = readOnly ? new loader.DatabaseSync(dbPath, { readOnly: true }) : new loader.DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    const driver: StateDbDriver = {
      allObjects: (sql, params) =>
        db!.prepare(sql).all(...params) as Array<Record<string, SqlValue>>,
      run: (sql, params) => {
        const result = db!.prepare(sql).run(...params);
        return Number(result?.changes ?? 0);
      },
      exec: (sql) => {
        db!.exec(sql);
      },
      snapshot: (destPath) => {
        // `VACUUM INTO` writes a fully checkpointed, self-contained copy with no
        // sidecars, taking its own read transaction — the one primitive here
        // that is consistent even while Codex is writing.
        if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
        try {
          db!.exec(`VACUUM INTO ${quoteSqliteString(destPath)}`);
          return;
        } catch {
          // Older SQLite or a temporarily locked page cache: fall back below.
        }
        const rows = db!.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
        if (Number(rows[0]?.busy ?? 0) !== 0) {
          throw new Error(
            `无法为 ${path.basename(dbPath)} 生成一致的备份：Codex 正在写入该数据库。请关闭 Codex 面板与所有运行 codex 的终端后重试。`
          );
        }
        fs.copyFileSync(dbPath, destPath);
      },
      flush: () => undefined,
      close: () => {
        try {
          db?.close();
        } catch {
          // Best effort.
        }
        db = undefined;
      }
    };
    const tables = driver.allObjects(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
      []
    );
    if (tables.length === 0) {
      driver.close();
      return undefined;
    }
    const columns = driver.allObjects("PRAGMA table_info(threads)", []);
    const names = columns.map((row) => String(row.name));
    if (!names.includes("id") || !names.includes("model_provider")) {
      driver.close();
      return undefined;
    }
    return driver;
  } catch {
    try {
      db?.close();
    } catch {
      // Best effort.
    }
    return undefined;
  }
}

/**
 * Poll until Codex has checkpointed its WAL. This must not block the thread: the
 * extension host is single-threaded, so a synchronous wait froze the entire VS Code
 * UI — including the progress notification meant to show that work was underway —
 * for as long as Codex kept the sidecar open.
 */
async function waitForWalSidecar(dbPath: string, walWaitMs: number): Promise<void> {
  const walPath = `${dbPath}-wal`;
  const deadline = Date.now() + walWaitMs;
  for (;;) {
    let active = false;
    if (fs.existsSync(walPath)) {
      try {
        active = fs.statSync(walPath).size > 0;
      } catch {
        // Recheck on the next round.
      }
    }
    if (!active) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Codex 仍在使用会话数据库（${path.basename(walPath)} 未清空）。请关闭 Codex 面板并退出所有运行 codex 的终端后重试；若仍失败，请完全退出 VS Code 后重新打开，并在打开 Codex 之前立即重试。`
      );
    }
    const remaining = Math.min(400, Math.max(0, deadline - Date.now()));
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
}

async function tryOpenSqlJsStateDb(dbPath: string, walWaitMs: number): Promise<StateDbDriver | undefined> {
  await waitForWalSidecar(dbPath, walWaitMs);
  const SQL = await getSqlJs();
  const data = fs.readFileSync(dbPath);
  const stat = fs.statSync(dbPath);
  const db = new SQL.Database(data);
  const driver: StateDbDriver = {
    allObjects: (sql, params) => {
      const result = db.exec(sql, params);
      const rows = result[0];
      if (!rows) return [];
      return rows.values.map((values) => {
        const record: Record<string, SqlValue> = {};
        rows.columns.forEach((column, index) => {
          record[column] = values[index];
        });
        return record;
      });
    },
    run: (sql, params) => {
      db.run(sql, params);
      return db.getRowsModified();
    },
    exec: (sql) => {
      db.exec(sql);
    },
    snapshot: (destPath) => {
      // The WAL wait above already proved there is nothing pending in a sidecar,
      // and no rewrite has happened yet, so the on-disk file is the snapshot.
      ensureFileUnchangedSync(dbPath, stat.mtimeMs, stat.size);
      fs.copyFileSync(dbPath, destPath);
    },
    flush: () => {
      ensureFileUnchangedSync(dbPath, stat.mtimeMs, stat.size);
      atomicWriteFileSync(dbPath, Buffer.from(db.export()));
    },
    close: () => {
      db.close();
    }
  };
  try {
    const tables = driver.allObjects(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
      []
    );
    if (tables.length === 0) {
      driver.close();
      return undefined;
    }
    const columns = driver.allObjects("PRAGMA table_info(threads)", []);
    const names = columns.map((row) => String(row.name));
    if (!names.includes("id") || !names.includes("model_provider")) {
      driver.close();
      return undefined;
    }
  } catch (error) {
    driver.close();
    throw error;
  }
  return driver;
}

async function openCodexStateDb(
  dbPath: string,
  walWaitMs: number,
  readOnly = false
): Promise<StateDbDriver | undefined> {
  if (!fs.existsSync(dbPath)) return undefined;
  const native = tryOpenNativeStateDb(dbPath, readOnly);
  if (native) return native;
  return tryOpenSqlJsStateDb(dbPath, walWaitMs);
}

/** ROLLBACK itself throws when no transaction is active; never mask the cause. */
function rollbackQuietly(driver: StateDbDriver): void {
  try {
    driver.exec("ROLLBACK");
  } catch {
    // The transaction was already resolved; the original error is the real one.
  }
}

async function migrateCodexStateDbFile(
  dbPath: string,
  codexDir: string,
  sourceTags: string[],
  backupRoot: string,
  walWaitMs: number
): Promise<number> {
  const driver = await openCodexStateDb(dbPath, walWaitMs);
  if (!driver) return 0;
  try {
    const placeholders = sourceTags.map(() => "?").join(", ");
    const counted = driver.allObjects(
      `SELECT COUNT(*) AS c FROM threads WHERE model_provider IN (${placeholders})`,
      sourceTags
    );
    const count = Number(counted[0]?.c ?? 0);
    if (count === 0) return 0;

    backupStateDbFileSync(driver, dbPath, codexDir, backupRoot);

    let changed = 0;
    driver.exec("BEGIN IMMEDIATE");
    try {
      changed = driver.run(
        `UPDATE threads SET model_provider = ? WHERE model_provider IN (${placeholders})`,
        [CODEX_UNIFIED_PROVIDER_ID, ...sourceTags]
      );
      driver.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(driver);
      throw error;
    }
    driver.flush();
    return changed;
  } finally {
    driver.close();
  }
}

async function restoreCodexStateDbFile(
  dbPath: string,
  codexDir: string,
  ledgerThreads: Map<string, string>,
  backupRoot: string,
  walWaitMs: number
): Promise<number> {
  const driver = await openCodexStateDb(dbPath, walWaitMs);
  if (!driver) return 0;
  try {
    const allIds = [...ledgerThreads.keys()];
    if (allIds.length === 0) return 0;

    let matching = 0;
    for (let offset = 0; offset < allIds.length; offset += STATE_DB_ID_CHUNK) {
      const chunk = allIds.slice(offset, offset + STATE_DB_ID_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const counted = driver.allObjects(
        `SELECT COUNT(*) AS c FROM threads WHERE model_provider = ? AND id IN (${placeholders})`,
        [CODEX_UNIFIED_PROVIDER_ID, ...chunk]
      );
      matching += Number(counted[0]?.c ?? 0);
    }
    if (matching === 0) return 0;

    backupStateDbFileSync(driver, dbPath, codexDir, backupRoot);

    const byTag = new Map<string, string[]>();
    for (const [threadId, originalTag] of ledgerThreads) {
      const ids = byTag.get(originalTag) ?? [];
      ids.push(threadId);
      byTag.set(originalTag, ids);
    }

    let changed = 0;
    driver.exec("BEGIN IMMEDIATE");
    try {
      for (const [originalTag, ids] of byTag) {
        for (let offset = 0; offset < ids.length; offset += STATE_DB_ID_CHUNK) {
          const chunk = ids.slice(offset, offset + STATE_DB_ID_CHUNK);
          const placeholders = chunk.map(() => "?").join(", ");
          changed += driver.run(
            `UPDATE threads SET model_provider = ? WHERE model_provider = ? AND id IN (${placeholders})`,
            [originalTag, CODEX_UNIFIED_PROVIDER_ID, ...chunk]
          );
        }
      }
      driver.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(driver);
      throw error;
    }
    driver.flush();
    return changed;
  } finally {
    driver.close();
  }
}

// ---------------------------------------------------------------------------
// Backup ledger
// ---------------------------------------------------------------------------

function collectBackupJsonlFiles(dir: string, files: string[], depth: number): void {
  if (depth > LEDGER_JSONL_MAX_DEPTH || !fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectBackupJsonlFiles(full, files, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
  }
}

function collectBackupStateDbs(dir: string, files: string[], depth: number): void {
  if (depth > LEDGER_STATE_MAX_DEPTH || !fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectBackupStateDbs(full, files, depth + 1);
    else if (entry.isFile() && (entry.name.endsWith(".sqlite") || entry.name.endsWith(".db"))) files.push(full);
  }
}

async function readLedgerThreadIdsFromBackupDb(
  dbPath: string,
  threads: Map<string, string>
): Promise<void> {
  // Read-only: the backup is the only recovery copy, so the ledger pass must
  // never write to it or leave -wal/-shm sidecars behind.
  const driver = await openCodexStateDb(dbPath, 0, true);
  if (!driver) return;
  try {
    const rows = driver.allObjects(
      "SELECT id, model_provider FROM threads WHERE model_provider <> ?",
      [CODEX_UNIFIED_PROVIDER_ID]
    );
    for (const row of rows) {
      const threadId = String(row.id);
      const provider = String(row.model_provider);
      if (threadId && provider) threads.set(threadId, provider);
    }
  } finally {
    driver.close();
  }
}

/**
 * Collects the migration ledger from every backup generation belonging to the
 * current Codex directory. A backup is by definition the pre-migration state,
 * so any tag in it other than the shared bucket IS an original tag — the ledger
 * deliberately does not consult the live provider list, otherwise deleting or
 * renaming a provider after migrating would strand its sessions in `custom`
 * with no way back. The ledger is the sole trust source for restore.
 */
export async function collectCodexUnifyLedger(
  backupParent: string,
  codexDirKey: string
): Promise<{ sessions: Map<string, string>; threads: Map<string, string> }> {
  const sessions = new Map<string, string>();
  const threads = new Map<string, string>();
  if (!fs.existsSync(backupParent)) return { sessions, threads };

  const entries = fs
    .readdirSync(backupParent, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const generation = path.join(backupParent, entry.name);
    if (!backupGenerationMatchesDir(generation, codexDirKey)) continue;

    const jsonlFiles: string[] = [];
    collectBackupJsonlFiles(path.join(generation, "jsonl"), jsonlFiles, 0);
    for (const file of jsonlFiles) {
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of content.split(/\r?\n/)) {
        const meta = parseSessionMetaTag(line);
        if (meta && meta.provider !== CODEX_UNIFIED_PROVIDER_ID && meta.sessionId) {
          sessions.set(meta.sessionId, meta.provider);
        }
      }
    }

    const stateDbs: string[] = [];
    collectBackupStateDbs(path.join(generation, "state"), stateDbs, 0);
    for (const dbFile of stateDbs) {
      await readLedgerThreadIdsFromBackupDb(dbFile, threads);
    }
  }
  return { sessions, threads };
}

/** Whether a restorable migration backup exists for the current Codex dir. */
export function hasCodexUnifyBackup(backupParent: string, codexDir: string): boolean {
  if (!fs.existsSync(backupParent)) return false;
  const codexDirKey = canonicalCodexDirKey(codexDir);
  const entries = fs.readdirSync(backupParent, { withFileTypes: true });
  return entries.some(
    (entry) => entry.isDirectory() && backupGenerationMatchesDir(path.join(backupParent, entry.name), codexDirKey)
  );
}

// ---------------------------------------------------------------------------
// Migration / restore entry points
// ---------------------------------------------------------------------------

function describeUnifyError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** One-line summary of per-item failures for a notification. */
export function summarizeCodexUnifyFailures(failures: CodexUnifyFailure[]): string {
  if (failures.length === 0) return "";
  const first = failures[0];
  const head = `${path.basename(first.path)}：${first.message}`;
  return failures.length === 1 ? head : `${head}（另有 ${failures.length - 1} 项失败）`;
}

export function buildCodexUnifySourceTags(thirdPartyTagIds: string[]): Set<string> {
  return new Set(
    [CODEX_OFFICIAL_PROVIDER_ID, ...thirdPartyTagIds]
      .map((tag) => tag.trim())
      .filter((tag) => tag && tag !== CODEX_UNIFIED_PROVIDER_ID)
  );
}

/**
 * Migrates official (`openai`) and legacy third-party tagged sessions into the
 * shared `custom` bucket. Only runs when the live config actually routes to
 * `custom`; otherwise it defers safely (`live_not_unified`) and touches nothing.
 */
export async function migrateCodexHistoryToUnifiedBucket(
  options: CodexUnifyMigrationOptions
): Promise<CodexUnifyMigrationOutcome> {
  const { codexDir, configText, thirdPartyTagIds, backupParent } = options;
  if (!codexConfigRoutesUnified(configText)) {
    return {
      migratedJsonlFiles: 0,
      migratedStateRows: 0,
      failures: [],
      skippedReason: "live_not_unified"
    };
  }
  const sources = buildCodexUnifySourceTags(thirdPartyTagIds);
  const backupRoot = path.join(backupParent, formatUnifyTimestamp(options.now ?? new Date()));
  const failures: CodexUnifyFailure[] = [];

  let migratedJsonlFiles = 0;
  for (const file of collectCodexJsonlFiles(codexDir)) {
    // Per file: a rollout Codex is actively appending to, or one that is locked
    // or unreadable, must not strand every other session in a half-migrated
    // state. Each rewrite is independent and separately backed up.
    try {
      const changed = rewriteCodexJsonlFile(
        file,
        codexDir,
        (provider) => (sources.has(provider) ? CODEX_UNIFIED_PROVIDER_ID : undefined),
        backupRoot
      );
      if (changed) migratedJsonlFiles += 1;
    } catch (error) {
      failures.push({ path: file, message: describeUnifyError(error) });
    }
  }

  let migratedStateRows = 0;
  for (const dbPath of getCodexStateDbCandidates(codexDir, configText)) {
    try {
      migratedStateRows += await migrateCodexStateDbFile(
        dbPath,
        codexDir,
        [...sources],
        backupRoot,
        options.walWaitMs ?? DEFAULT_WAL_WAIT_MS
      );
    } catch (error) {
      failures.push({ path: dbPath, message: describeUnifyError(error) });
    }
  }

  if (fs.existsSync(backupRoot)) {
    writeBackupGenerationMeta(backupRoot, canonicalCodexDirKey(codexDir));
  }
  if (migratedJsonlFiles === 0 && migratedStateRows === 0 && failures.length === 0) {
    return {
      migratedJsonlFiles: 0,
      migratedStateRows: 0,
      failures,
      skippedReason: "nothing_to_migrate"
    };
  }
  return { migratedJsonlFiles, migratedStateRows, failures };
}

/**
 * Restores sessions that were migrated in, based solely on the backup ledger:
 * only entries that are [in the ledger AND currently still `custom`] are
 * flipped back to their original tag. Sessions created while the unified toggle
 * was on are in no ledger and are never touched. The current state is backed up
 * to a separate restore directory before any rewrite.
 */
export async function restoreCodexHistoryFromBackups(
  options: CodexUnifyRestoreOptions
): Promise<CodexUnifyRestoreOutcome> {
  const { codexDir, backupParent, restoreBackupParent } = options;
  const codexDirKey = canonicalCodexDirKey(codexDir);
  const ledger = await collectCodexUnifyLedger(backupParent, codexDirKey);
  if (ledger.sessions.size === 0 && ledger.threads.size === 0) {
    return {
      restoredJsonlFiles: 0,
      restoredStateRows: 0,
      failures: [],
      skippedReason: "no_backup_ledger"
    };
  }

  const restoreRoot = path.join(restoreBackupParent, formatUnifyTimestamp(options.now ?? new Date()));
  const failures: CodexUnifyFailure[] = [];

  let restoredJsonlFiles = 0;
  for (const file of collectCodexJsonlFiles(codexDir)) {
    try {
      const changed = rewriteCodexJsonlFile(
        file,
        codexDir,
        (provider, sessionId) =>
          provider === CODEX_UNIFIED_PROVIDER_ID ? ledger.sessions.get(sessionId) : undefined,
        restoreRoot
      );
      if (changed) restoredJsonlFiles += 1;
    } catch (error) {
      failures.push({ path: file, message: describeUnifyError(error) });
    }
  }

  let restoredStateRows = 0;
  const configText = (() => {
    const configFile = path.join(codexDir, "config.toml");
    try {
      return fs.readFileSync(configFile, "utf8");
    } catch {
      return "";
    }
  })();
  for (const dbPath of getCodexStateDbCandidates(codexDir, configText)) {
    try {
      restoredStateRows += await restoreCodexStateDbFile(
        dbPath,
        codexDir,
        ledger.threads,
        restoreRoot,
        options.walWaitMs ?? DEFAULT_WAL_WAIT_MS
      );
    } catch (error) {
      failures.push({ path: dbPath, message: describeUnifyError(error) });
    }
  }

  if (fs.existsSync(restoreRoot)) {
    writeBackupGenerationMeta(restoreRoot, codexDirKey);
  }
  if (restoredJsonlFiles === 0 && restoredStateRows === 0 && failures.length === 0) {
    return {
      restoredJsonlFiles: 0,
      restoredStateRows: 0,
      failures,
      skippedReason: "nothing_to_restore"
    };
  }
  return { restoredJsonlFiles, restoredStateRows, failures };
}
