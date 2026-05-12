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
  if (!irColumns.includes('downloaded_at')) {
    console.log('[database] 迁移：image_records 添加 downloaded_at 列...');
    db.exec(`ALTER TABLE image_records ADD COLUMN downloaded_at DATETIME`);
    console.log('[database] 迁移完成：image_records.downloaded_at 已添加');
  }

  // 增量迁移：tasks 添加 task_kind 字段（用于区分音频生成中间产物）
  const tasksColumns = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!tasksColumns.includes('task_kind')) {
    console.log('[database] 迁移：tasks 添加 task_kind 列...');
    db.exec(`ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'video'`);
    console.log('[database] 迁移完成：tasks.task_kind 已添加');
  }

  // 增量迁移：audio_generations 表（音频生成记录）
  db.exec(`
    CREATE TABLE IF NOT EXISTS audio_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER UNIQUE,
      user_id INTEGER NOT NULL,
      project_id INTEGER,
      reference_image_url TEXT NOT NULL,
      voice_prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','generating','done','error')),
      intermediate_video_url TEXT,
      credits_used INTEGER DEFAULT 0,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_audio_generations_user ON audio_generations(user_id);
    CREATE INDEX IF NOT EXISTS idx_audio_generations_status ON audio_generations(status);
    CREATE INDEX IF NOT EXISTS idx_audio_generations_task ON audio_generations(task_id);
  `);

  // 增量迁移：audio_generations 添加 downloaded_at（与 image_records 一致，统一持久化下载状态）
  const agColumns = db.prepare("PRAGMA table_info(audio_generations)").all().map(c => c.name);
  if (!agColumns.includes('downloaded_at')) {
    console.log('[database] 迁移：audio_generations 添加 downloaded_at 列...');
    db.exec(`ALTER TABLE audio_generations ADD COLUMN downloaded_at DATETIME`);
    console.log('[database] 迁移完成：audio_generations.downloaded_at 已添加');
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
