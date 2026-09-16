function currentSchemaVersion(migrations) {
  const ordered = orderedMigrations(migrations);
  return ordered.length ? ordered[ordered.length - 1].version : 0;
}

function applyOrderedMigrations(db, { migrations, fromVersion, backupPath = null, appliedAt } = {}) {
  const pending = orderedMigrations(migrations).filter((item) => item.version > Number(fromVersion || 0));
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      migration.apply(db);
      db.prepare(`INSERT OR REPLACE INTO schema_migrations(version, name, applied_at, backup_path)
        VALUES (?, ?, ?, ?)`).run(migration.version, migration.name, appliedAt(), backupPath || null);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function orderedMigrations(value) {
  if (!Array.isArray(value)) throw new TypeError("migrations must be an array");
  let previous = 0;
  for (const migration of value) {
    if (!Number.isInteger(migration?.version) || migration.version <= previous) {
      throw new TypeError("migrations must have strictly increasing integer versions");
    }
    if (!String(migration.name || "").trim() || typeof migration.apply !== "function") {
      throw new TypeError(`migration v${migration.version} is invalid`);
    }
    previous = migration.version;
  }
  return value;
}

module.exports = { currentSchemaVersion, applyOrderedMigrations };
