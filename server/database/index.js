import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/seedance.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;

export function initDatabase() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  const existingTableCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get().count;

  if (existingTableCount === 0) {
    const schemaPath = path.join(__dirname, 'schema.sql');
    db.exec(fs.readFileSync(schemaPath, 'utf-8'));
    console.log('[database] 全新安装，已应用 schema.sql');
  }

  // 增量迁移：credit_locks 支持图片生成（task_id 可空 + image_record_id）
  const clColumns = db.prepare("PRAGMA table_info(credit_locks)").all().map(c => c.name);
  if (!clColumns.includes('image_record_id')) {
    console.log('[database] 迁移：重建 credit_locks 以支持图片生成...');
    db.exec(`
      BEGIN;
      ALTER TABLE credit_locks RENAME TO credit_locks_old;
      CREATE TABLE credit_locks (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            INTEGER NOT NULL,
        task_id            INTEGER UNIQUE,
        image_record_id    INTEGER UNIQUE,
        estimated_credits  INTEGER NOT NULL,
        locked_credits     INTEGER NOT NULL,
        status             TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked', 'settled', 'released')),
        actual_credits     INTEGER,
        release_reason     TEXT,
        meta               TEXT,
        created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
        settled_at         DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      INSERT INTO credit_locks (id, user_id, task_id, image_record_id, estimated_credits, locked_credits, status, actual_credits, release_reason, meta, created_at, settled_at)
        SELECT id, user_id, task_id, NULL, estimated_credits, locked_credits, status, actual_credits, release_reason, meta, created_at, settled_at FROM credit_locks_old;
      DROP TABLE credit_locks_old;
      CREATE INDEX IF NOT EXISTS idx_credit_locks_user_status ON credit_locks(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_credit_locks_task ON credit_locks(task_id);
      CREATE INDEX IF NOT EXISTS idx_credit_locks_image ON credit_locks(image_record_id);
      COMMIT;
    `);
    console.log('[database] 迁移完成：credit_locks 已升级');
  }

  // 增量迁移：image_records 添加 status 字段（pending/done/error）
  const irColumns = db.prepare("PRAGMA table_info(image_records)").all().map(c => c.name);
  if (!irColumns.includes('status')) {
    console.log('[database] 迁移：image_records 添加 status 列...');
    db.exec(`ALTER TABLE image_records ADD COLUMN status TEXT NOT NULL DEFAULT 'done'`);
    console.log('[database] 迁移完成：image_records.status 已添加');
  }

  console.log(`[database] 数据库初始化成功：${DB_PATH}`);
  return db;
}

export function getDatabase() {
  if (!db) return initDatabase();
  return db;
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log('[database] 数据库连接已关闭');
  }
}

export function transaction(fn) {
  const database = getDatabase();
  return database.transaction(fn)();
}

export default { initDatabase, getDatabase, closeDatabase, transaction };
