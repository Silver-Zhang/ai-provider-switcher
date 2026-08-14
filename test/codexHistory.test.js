const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const initSqlJs = require("sql.js");
const {
  CODEX_OFFICIAL_PROVIDER_ID,
  CODEX_UNIFIED_PROVIDER_ID,
  canonicalCodexDirKey,
  codexConfigRoutesUnified,
  codexCustomSectionMatchesUnifiedOfficial,
  getCodexStateDbCandidates,
  hasCodexCustomProviderSection,
  hasCodexUnifyBackup,
  migrateCodexHistoryToUnifiedBucket,
  overrideNativeSqliteForTests,
  parseCodexTopLevelScalar,
  restoreCodexHistoryFromBackups,
  serializeCodexUnifiedOfficialBlock,
  serializeCodexUnifiedProviderBlock,
  summarizeCodexUnifyFailures
} = require("../out/codexHistory.js");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-history-test-"));
}

function sessionMetaLine(sessionId, provider) {
  return JSON.stringify({ type: "session_meta", payload: { id: sessionId, model_provider: provider } });
}

async function makeStateDb(dbPath, rows) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
  for (const [id, provider] of rows) {
    db.run("INSERT INTO threads (id, model_provider) VALUES (?, ?)", [id, provider]);
  }
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function readThreadTags(dbPath) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const rows = db.exec("SELECT id, model_provider FROM threads");
  db.close();
  const tags = {};
  for (const row of rows[0].values) tags[String(row[0])] = String(row[1]);
  return tags;
}

function listBackupGenerations(backupParent) {
  if (!fs.existsSync(backupParent)) return [];
  return fs.readdirSync(backupParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const ROUTED_CONFIG = `model = "gpt-5.5"\nmodel_provider = "custom"\n`;

test("detects whether the live config routes to the shared custom bucket", () => {
  assert.equal(codexConfigRoutesUnified(ROUTED_CONFIG), true);
  assert.equal(codexConfigRoutesUnified("model_provider = \"openai\"\n"), false);
  assert.equal(codexConfigRoutesUnified(""), false);
  assert.equal(codexConfigRoutesUnified("[model_providers.custom]\nname = \"x\"\n"), false);
  assert.equal(codexConfigRoutesUnified("not toml [["), false);
});

test("serializes the official and provider unified custom blocks", () => {
  const official = serializeCodexUnifiedOfficialBlock();
  assert.ok(official.includes("[model_providers.custom]"));
  assert.ok(official.includes("name = \"OpenAI\""));
  assert.ok(official.includes("requires_openai_auth = true"));
  assert.ok(official.includes("supports_websockets = true"));
  assert.ok(official.includes("wire_api = \"responses\""));

  const relay = serializeCodexUnifiedProviderBlock(
    { name: "Relay", baseUrl: "https://relay.example/v1" },
    { command: "/home/me/.codex/auth.sh", args: ["/home/me/.codex/key"] }
  );
  assert.ok(relay.includes("name = \"Relay\""));
  assert.ok(relay.includes("base_url = \"https://relay.example/v1\""));
  assert.ok(relay.includes("[model_providers.custom.auth]"));
  assert.ok(relay.includes("command = \"/home/me/.codex/auth.sh\""));
});

test("detects custom provider sections and the injected official shape", () => {
  assert.equal(hasCodexCustomProviderSection(ROUTED_CONFIG), false);
  assert.equal(
    hasCodexCustomProviderSection("[model_providers.custom]\nname = \"Relay\"\nbase_url = \"https://x/v1\"\n"),
    true
  );
  assert.equal(
    codexCustomSectionMatchesUnifiedOfficial(`[model_providers.custom]\n${serializeCodexUnifiedOfficialBlock().split("\n").slice(1).join("\n")}\n`),
    true
  );
  assert.equal(
    codexCustomSectionMatchesUnifiedOfficial("[model_providers.custom]\nname = \"Relay\"\nbase_url = \"https://x/v1\"\n"),
    false
  );
});

test("parses top-level scalars with double and single quotes", () => {
  assert.equal(parseCodexTopLevelScalar("sqlite_home = \"/tmp/db\"\n", "sqlite_home"), "/tmp/db");
  assert.equal(parseCodexTopLevelScalar("sqlite_home = '/tmp/db'\n", "sqlite_home"), "/tmp/db");
  assert.equal(
    parseCodexTopLevelScalar("[model_providers.custom]\nsqlite_home = \"/nope\"\n", "sqlite_home"),
    undefined
  );
  assert.equal(parseCodexTopLevelScalar("", "sqlite_home"), undefined);
});

test("discovers state db candidates including config and env sqlite_home", () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    const configHome = path.join(dir, "config-home");
    const envHome = path.join(dir, "env-home");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(configHome, { recursive: true });
    fs.mkdirSync(envHome, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "state_5.sqlite"), "");
    fs.writeFileSync(path.join(configHome, "state.db"), "");

    const withConfig = getCodexStateDbCandidates(codexDir, `sqlite_home = '${configHome}'`);
    assert.deepEqual(
      withConfig.map((item) => path.basename(item)).sort(),
      ["state.db", "state_5.sqlite"]
    );

    const previous = process.env.CODEX_SQLITE_HOME;
    try {
      process.env.CODEX_SQLITE_HOME = envHome;
      const withEnv = getCodexStateDbCandidates(codexDir, "");
      assert.ok(withEnv.some((item) => item === path.join(codexDir, "state_5.sqlite")));
      assert.equal(withEnv.length, 1, "empty state.db in env home should not appear");
    } finally {
      if (previous === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = previous;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates jsonl session tags into the custom bucket with backups", async () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    const sessionDir = path.join(codexDir, "sessions", "2026", "06", "12");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "local.jsonl");
    fs.writeFileSync(
      sessionPath,
      [
        sessionMetaLine("s1", "openai"),
        sessionMetaLine("s2", "codex-relay"),
        sessionMetaLine("s3", "custom"),
        sessionMetaLine("s4", "my-private-relay"),
        JSON.stringify({ type: "response_item", payload: { text: "openai" } })
      ].join("\n") + "\n"
    );
    fs.writeFileSync(path.join(codexDir, "config.toml"), ROUTED_CONFIG);

    const backupParent = path.join(codexDir, "ai-provider-switcher-backups", "unify");
    const outcome = await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: ROUTED_CONFIG,
      thirdPartyTagIds: ["codex-relay"],
      backupParent,
      now: new Date("2026-06-12T01:02:03Z")
    });

    assert.equal(outcome.skippedReason, undefined);
    assert.equal(outcome.migratedJsonlFiles, 1);
    assert.equal(outcome.migratedStateRows, 0);

    const text = fs.readFileSync(sessionPath, "utf8");
    assert.ok(text.includes(sessionMetaLine("s1", "custom")));
    assert.ok(text.includes(sessionMetaLine("s2", "custom")));
    assert.ok(text.includes(sessionMetaLine("s3", "custom")));
    assert.ok(text.includes(sessionMetaLine("s4", "my-private-relay")));
    assert.ok(text.includes(JSON.stringify({ type: "response_item", payload: { text: "openai" } })));

    const generations = listBackupGenerations(backupParent);
    assert.equal(generations.length, 1);
    const backup = path.join(backupParent, generations[0]);
    assert.ok(fs.existsSync(path.join(backup, "jsonl", "sessions", "2026", "06", "12", "local.jsonl")));
    assert.ok(fs.existsSync(path.join(backup, "meta.json")));

    const rerun = await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: ROUTED_CONFIG,
      thirdPartyTagIds: ["codex-relay"],
      backupParent,
      now: new Date("2026-06-12T02:00:00Z")
    });
    assert.equal(rerun.skippedReason, "nothing_to_migrate");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("defers migration when the live config does not route to custom", async () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(path.join(codexDir, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "sessions", "s.jsonl"),
      sessionMetaLine("s1", "openai") + "\n"
    );

    const outcome = await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: "model_provider = \"openai\"\n",
      thirdPartyTagIds: [],
      backupParent: path.join(codexDir, "backups")
    });
    assert.equal(outcome.skippedReason, "live_not_unified");
    assert.equal(
      fs.readFileSync(path.join(codexDir, "sessions", "s.jsonl"), "utf8"),
      sessionMetaLine("s1", "openai") + "\n"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates the state db thread tags transactionally with backups", async () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const dbPath = path.join(codexDir, "state_5.sqlite");
    await makeStateDb(dbPath, [
      ["t1", "openai"],
      ["t2", "codex-relay"],
      ["t3", "custom"],
      ["t4", "my-private-relay"]
    ]);
    fs.writeFileSync(path.join(codexDir, "config.toml"), ROUTED_CONFIG);

    const backupParent = path.join(codexDir, "ai-provider-switcher-backups", "unify");
    const outcome = await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: ROUTED_CONFIG,
      thirdPartyTagIds: ["codex-relay"],
      backupParent,
      now: new Date("2026-06-12T01:02:03Z")
    });
    assert.equal(outcome.migratedStateRows, 2);

    const tags = await readThreadTags(dbPath);
    assert.equal(tags.t1, "custom");
    assert.equal(tags.t2, "custom");
    assert.equal(tags.t3, "custom");
    assert.equal(tags.t4, "my-private-relay");

    const generations = listBackupGenerations(backupParent);
    assert.equal(generations.length, 1);
    assert.ok(fs.existsSync(path.join(backupParent, generations[0], "state", "state_5.sqlite")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sql.js fallback refuses a state db with an active WAL sidecar", async () => {
  const dir = makeTempDir();
  overrideNativeSqliteForTests(false);
  try {
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const dbPath = path.join(codexDir, "state_5.sqlite");
    await makeStateDb(dbPath, [["t1", "openai"]]);
    fs.writeFileSync(`${dbPath}-wal`, "wal-content");
    fs.writeFileSync(path.join(codexDir, "config.toml"), ROUTED_CONFIG);

    // The refusal is now reported as a per-database failure instead of
    // rejecting the whole run, but the database itself stays untouched.
    const outcome = await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: ROUTED_CONFIG,
      thirdPartyTagIds: [],
      backupParent: path.join(codexDir, "backups"),
      walWaitMs: 0
    });
    assert.equal(outcome.migratedStateRows, 0);
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0].path, dbPath);
    assert.match(outcome.failures[0].message, /未清空/);

    const tags = await readThreadTags(dbPath);
    assert.equal(tags.t1, "openai");
  } finally {
    overrideNativeSqliteForTests(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state db backup captures rows still pending in the WAL sidecar", async (t) => {
  let DatabaseSync;
  try {
    DatabaseSync = require("node:sqlite").DatabaseSync;
  } catch {
    t.skip("node:sqlite not available in this Node runtime");
    return;
  }
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const dbPath = path.join(codexDir, "state_5.sqlite");

    // Hold a WAL connection open with checkpointing disabled, so the row exists
    // ONLY in the -wal sidecar and not in the main database file.
    const holder = new DatabaseSync(dbPath);
    holder.exec("PRAGMA journal_mode = WAL");
    holder.exec("PRAGMA wal_autocheckpoint = 0");
    holder.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
    holder.exec("INSERT INTO threads (id, model_provider) VALUES ('t1', 'openai')");
    assert.ok(fs.statSync(`${dbPath}-wal`).size > 0, "setup: rows must still sit in the WAL");

    fs.writeFileSync(path.join(codexDir, "config.toml"), ROUTED_CONFIG);
    const backupParent = path.join(codexDir, "backups");
    let outcome;
    try {
      outcome = await migrateCodexHistoryToUnifiedBucket({
        codexDir,
        configText: ROUTED_CONFIG,
        thirdPartyTagIds: [],
        backupParent,
        walWaitMs: 0,
        now: new Date("2026-06-12T01:02:03Z")
      });
    } finally {
      holder.close();
    }
    assert.deepEqual(outcome.failures, []);
    assert.equal(outcome.migratedStateRows, 1);

    // A bare file copy of a WAL database would have backed up an empty table,
    // silently dropping t1 from the restore ledger.
    const generations = listBackupGenerations(backupParent);
    assert.equal(generations.length, 1);
    const backupDb = path.join(backupParent, generations[0], "state", "state_5.sqlite");
    const backedUp = (() => {
      const reader = new DatabaseSync(backupDb, { readOnly: true });
      try {
        return reader.prepare("SELECT model_provider AS p FROM threads WHERE id = 't1'").get();
      } catch (error) {
        return { p: `unreadable backup: ${error.message}` };
      } finally {
        reader.close();
      }
    })();
    assert.equal(backedUp?.p, "openai");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one unusable state db is reported without aborting the rest of the run", async () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    const sessionDir = path.join(codexDir, "sessions", "2026", "06", "12");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "local.jsonl"), sessionMetaLine("s1", "openai") + "\n");

    // state_5.sqlite is scanned first and cannot be opened at all; state.db is
    // healthy and must still be migrated.
    fs.mkdirSync(path.join(codexDir, "state_5.sqlite"));
    await makeStateDb(path.join(codexDir, "state.db"), [["t1", "openai"]]);
    fs.writeFileSync(path.join(codexDir, "config.toml"), ROUTED_CONFIG);

    const outcome = await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: ROUTED_CONFIG,
      thirdPartyTagIds: [],
      backupParent: path.join(codexDir, "backups"),
      walWaitMs: 0,
      now: new Date("2026-06-12T01:02:03Z")
    });

    assert.equal(outcome.failures.length, 1);
    assert.equal(path.basename(outcome.failures[0].path), "state_5.sqlite");
    assert.equal(outcome.migratedJsonlFiles, 1);
    assert.equal(outcome.migratedStateRows, 1);
    assert.equal((await readThreadTags(path.join(codexDir, "state.db"))).t1, "custom");
    assert.ok(summarizeCodexUnifyFailures(outcome.failures).includes("state_5.sqlite"));
    assert.equal(summarizeCodexUnifyFailures([]), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("native sqlite driver migrates a live WAL database held open by another connection", async (t) => {
  let DatabaseSync;
  try {
    DatabaseSync = require("node:sqlite").DatabaseSync;
  } catch {
    t.skip("node:sqlite not available in this Node runtime");
    return;
  }
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const dbPath = path.join(codexDir, "state_5.sqlite");

    // Simulate the Codex extension: open a real WAL connection and keep it open.
    const holder = new DatabaseSync(dbPath);
    holder.exec("PRAGMA journal_mode = WAL");
    holder.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
    holder.exec("INSERT INTO threads (id, model_provider) VALUES ('t1', 'openai')");
    assert.ok(fs.existsSync(`${dbPath}-wal`));

    fs.writeFileSync(path.join(codexDir, "config.toml"), ROUTED_CONFIG);
    const outcome = await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: ROUTED_CONFIG,
      thirdPartyTagIds: [],
      backupParent: path.join(codexDir, "backups"),
      walWaitMs: 0
    });
    assert.equal(outcome.migratedStateRows, 1);

    const reader = new DatabaseSync(dbPath);
    const row = reader.prepare("SELECT model_provider AS p FROM threads WHERE id = 't1'").get();
    assert.equal(row.p, "custom");
    reader.close();
    holder.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restores only ledgered sessions that are still tagged custom", async () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    const sessionDir = path.join(codexDir, "sessions", "2026", "06", "12");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "local.jsonl");
    fs.writeFileSync(
      sessionPath,
      [
        sessionMetaLine("s1", "openai"),
        sessionMetaLine("s2", "codex-relay")
      ].join("\n") + "\n"
    );
    fs.writeFileSync(path.join(codexDir, "config.toml"), ROUTED_CONFIG);

    const backupParent = path.join(codexDir, "ai-provider-switcher-backups", "unify");
    const restoreParent = path.join(codexDir, "ai-provider-switcher-backups", "restore");
    await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: ROUTED_CONFIG,
      thirdPartyTagIds: ["codex-relay"],
      backupParent,
      now: new Date("2026-06-12T01:02:03Z")
    });

    // Session created while unified was on: tagged custom, in no ledger.
    const onPeriod = path.join(sessionDir, "on-period.jsonl");
    fs.writeFileSync(onPeriod, sessionMetaLine("s9", "custom") + "\n");

    assert.equal(hasCodexUnifyBackup(backupParent, codexDir), true);

    const restore = await restoreCodexHistoryFromBackups({
      codexDir,
      backupParent,
      restoreBackupParent: restoreParent,
      now: new Date("2026-06-13T01:02:03Z")
    });
    assert.equal(restore.skippedReason, undefined);
    assert.equal(restore.restoredJsonlFiles, 1);

    const text = fs.readFileSync(sessionPath, "utf8");
    assert.ok(text.includes(sessionMetaLine("s1", "openai")));
    assert.ok(text.includes(sessionMetaLine("s2", "codex-relay")));
    assert.equal(fs.readFileSync(onPeriod, "utf8"), sessionMetaLine("s9", "custom") + "\n");

    const restoreGenerations = listBackupGenerations(restoreParent);
    assert.equal(restoreGenerations.length, 1);

    const rerun = await restoreCodexHistoryFromBackups({
      codexDir,
      backupParent,
      restoreBackupParent: restoreParent,
      now: new Date("2026-06-13T02:00:00Z")
    });
    assert.equal(rerun.skippedReason, "nothing_to_restore");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore reports no_backup_ledger and hasCodexUnifyBackup is false without backups", async () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(path.join(codexDir, "sessions"), { recursive: true });
    assert.equal(hasCodexUnifyBackup(path.join(codexDir, "missing-backups"), codexDir), false);
    const outcome = await restoreCodexHistoryFromBackups({
      codexDir,
      backupParent: path.join(codexDir, "missing-backups"),
      restoreBackupParent: path.join(codexDir, "restore")
    });
    assert.equal(outcome.skippedReason, "no_backup_ledger");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore flips state db rows per the ledger and leaves others alone", async () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const dbPath = path.join(codexDir, "state.db");
    await makeStateDb(dbPath, [
      ["t1", "openai"],
      ["t2", "codex-relay"]
    ]);
    fs.writeFileSync(path.join(codexDir, "config.toml"), ROUTED_CONFIG);

    const backupParent = path.join(codexDir, "ai-provider-switcher-backups", "unify");
    await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: ROUTED_CONFIG,
      thirdPartyTagIds: ["codex-relay"],
      backupParent,
      now: new Date("2026-06-12T01:02:03Z")
    });

    // t3 was created while unified was on and is in no ledger.
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(dbPath));
    db.run("INSERT INTO threads (id, model_provider) VALUES ('t3', 'custom')");
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();

    const restore = await restoreCodexHistoryFromBackups({
      codexDir,
      backupParent,
      restoreBackupParent: path.join(codexDir, "ai-provider-switcher-backups", "restore"),
      now: new Date("2026-06-13T01:02:03Z")
    });
    assert.equal(restore.restoredStateRows, 2);

    const tags = await readThreadTags(dbPath);
    assert.equal(tags.t1, "openai");
    assert.equal(tags.t2, "codex-relay");
    assert.equal(tags.t3, "custom");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore recovers providers that no longer exist in settings", async () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    const sessionDir = path.join(codexDir, "sessions", "2026", "06", "12");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "local.jsonl");
    fs.writeFileSync(sessionPath, sessionMetaLine("s1", "codex-deleted-relay") + "\n");
    const dbPath = path.join(codexDir, "state.db");
    await makeStateDb(dbPath, [["t1", "codex-deleted-relay"]]);
    fs.writeFileSync(path.join(codexDir, "config.toml"), ROUTED_CONFIG);

    const backupParent = path.join(codexDir, "ai-provider-switcher-backups", "unify");
    const migrated = await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: ROUTED_CONFIG,
      thirdPartyTagIds: ["codex-deleted-relay"],
      backupParent,
      now: new Date("2026-06-12T01:02:03Z")
    });
    assert.equal(migrated.migratedStateRows, 1);

    // The provider is deleted from settings between migrate and restore; the
    // ledger comes from the backup, so its sessions must still come back.
    const restore = await restoreCodexHistoryFromBackups({
      codexDir,
      backupParent,
      restoreBackupParent: path.join(codexDir, "ai-provider-switcher-backups", "restore"),
      now: new Date("2026-06-13T01:02:03Z")
    });
    assert.deepEqual(restore.failures, []);
    assert.equal(restore.restoredJsonlFiles, 1);
    assert.equal(restore.restoredStateRows, 1);
    assert.ok(fs.readFileSync(sessionPath, "utf8").includes(sessionMetaLine("s1", "codex-deleted-relay")));
    assert.equal((await readThreadTags(dbPath)).t1, "codex-deleted-relay");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reading the ledger never writes to the backup database", async () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const dbPath = path.join(codexDir, "state.db");
    await makeStateDb(dbPath, [["t1", "openai"]]);
    fs.writeFileSync(path.join(codexDir, "config.toml"), ROUTED_CONFIG);

    const backupParent = path.join(codexDir, "ai-provider-switcher-backups", "unify");
    await migrateCodexHistoryToUnifiedBucket({
      codexDir,
      configText: ROUTED_CONFIG,
      thirdPartyTagIds: [],
      backupParent,
      now: new Date("2026-06-12T01:02:03Z")
    });

    const stateDir = path.join(backupParent, listBackupGenerations(backupParent)[0], "state");
    const before = fs.statSync(path.join(stateDir, "state.db"));
    await restoreCodexHistoryFromBackups({
      codexDir,
      backupParent,
      restoreBackupParent: path.join(codexDir, "ai-provider-switcher-backups", "restore"),
      now: new Date("2026-06-13T01:02:03Z")
    });

    const after = fs.statSync(path.join(stateDir, "state.db"));
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(
      fs.readdirSync(stateDir).sort(),
      ["state.db"],
      "read-only ledger access must not leave -wal/-shm sidecars behind"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical dir keys and backup dir binding", () => {
  const dir = makeTempDir();
  try {
    const nested = path.join(dir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(canonicalCodexDirKey(nested), fs.realpathSync(nested));
    assert.equal(canonicalCodexDirKey(path.join(dir, "missing")), path.resolve(path.join(dir, "missing")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup generations from another codex dir are ignored by the probe", () => {
  const dir = makeTempDir();
  try {
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const backupParent = path.join(dir, "backups");
    const otherGeneration = path.join(backupParent, "20260612_010101");
    fs.mkdirSync(otherGeneration, { recursive: true });
    fs.writeFileSync(path.join(otherGeneration, "meta.json"), JSON.stringify({ codexConfigDir: "/other/codex-dir" }));
    assert.equal(hasCodexUnifyBackup(backupParent, codexDir), false);

    const matchingGeneration = path.join(backupParent, "20260612_020202");
    fs.mkdirSync(matchingGeneration, { recursive: true });
    fs.writeFileSync(
      path.join(matchingGeneration, "meta.json"),
      JSON.stringify({ codexConfigDir: canonicalCodexDirKey(codexDir) })
    );
    assert.equal(hasCodexUnifyBackup(backupParent, codexDir), true);

    // Legacy generation without meta.json is tolerated.
    const legacyGeneration = path.join(backupParent, "20260612_030303");
    fs.mkdirSync(legacyGeneration, { recursive: true });
    assert.equal(hasCodexUnifyBackup(backupParent, codexDir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
