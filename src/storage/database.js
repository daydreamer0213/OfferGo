const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { applyOrderedMigrations } = require("./migrations");

function openDatabase(dbPath, { schemaVersion, migrations, nowIso } = {}) {
  const memoryDb = dbPath === ":memory:";
  const existed = memoryDb ? false : fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  if (!memoryDb) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const fromVersion = Number(db.prepare("PRAGMA user_version").get().user_version || 0);
    if (fromVersion > schemaVersion) {
      throw databaseMigrationError(
        "DB_SCHEMA_NEWER_THAN_APP",
        `数据库版本 ${fromVersion} 高于当前程序支持的 ${schemaVersion}，请升级 OfferGo。`
      );
    }
    if (fromVersion < schemaVersion) {
      assertDatabaseHealthy(db, "迁移前");
      const backupPath = existed && !memoryDb
        ? createMigrationBackup(db, dbPath, fromVersion, schemaVersion)
        : "";
      try {
        applyOrderedMigrations(db, {
          migrations,
          fromVersion,
          backupPath,
          appliedAt: nowIso
        });
      } catch (error) {
        const wrapped = databaseMigrationError(
          "DB_MIGRATION_FAILED",
          `数据库从 v${fromVersion} 升级到 v${schemaVersion} 失败：${error.message}`,
          error
        );
        wrapped.backupPath = backupPath || null;
        throw wrapped;
      }
      assertDatabaseHealthy(db, "迁移后");
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function createMigrationBackup(db, dbPath, fromVersion, toVersion) {
  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = path.extname(dbPath) || ".sqlite";
  const baseName = path.basename(dbPath, path.extname(dbPath));
  const backupPath = path.join(
    backupDir,
    `${baseName}-before-v${fromVersion}-to-v${toVersion}-${stamp}-${process.pid}${extension}`
  );
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  return backupPath;
}

function assertDatabaseHealthy(db, phase) {
  const row = db.prepare("PRAGMA quick_check").get();
  const result = row?.quick_check || Object.values(row || {})[0];
  if (result !== "ok") {
    throw databaseMigrationError("DB_INTEGRITY_CHECK_FAILED", `${phase}数据库完整性检查失败：${result || "unknown"}`);
  }
}

function databaseMigrationError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

module.exports = { openDatabase, createMigrationBackup, assertDatabaseHealthy };
