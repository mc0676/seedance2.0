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
  if (!irColumns.includes('error_message')) {
    console.log('[database] 迁移：image_records 添加 error_message 列...');
    db.exec(`ALTER TABLE image_records ADD COLUMN error_message TEXT`);
    console.log('[database] 迁移完成：image_records.error_message 已添加');
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

  // 增量迁移：video_enhancements 升级到新计费模型
  // 1) 删除旧 enhancement_pricing 表（按秒积分模型已废弃，新规则改为系数表 + 系统配置）
  // 2) target_resolution CHECK 加入 '2k'，新增 target_fps / result_resolution / result_fps 列
  // 3) 写入默认 system_config 'enhancement_base_credits_per_minute'
  const oldPricingExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='enhancement_pricing'")
    .get();
  if (oldPricingExists) {
    console.log('[database] 迁移：删除旧 enhancement_pricing 表（按秒积分模型已废弃）...');
    db.exec(`DROP TABLE enhancement_pricing`);
    console.log('[database] 迁移完成：enhancement_pricing 已删除');
  }
  db.prepare(
    `INSERT OR IGNORE INTO system_config (key, value, description)
     VALUES ('enhancement_base_credits_per_minute', '75', '画质增强基础单价（积分/分钟）')`
  ).run();

  const veSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='video_enhancements'"
  ).get();
  const veSql = veSqlRow?.sql || '';
  const veColumns = db.prepare("PRAGMA table_info(video_enhancements)").all().map((c) => c.name);
  // 重建条件：
  //  - CHECK 不含 '2k'（仍是 '720p','1080p','4k'）
  //  - 或缺少 resolution_limit 列（新加的精确短边像素，与 target_resolution 互斥）
  //  - 或 target_resolution 仍为 NOT NULL（精确模式需把它置 NULL）
  //  - 缺 downloaded_at 时用 ALTER 单独补，不重建（见下方 else 分支）
  const needsRebuild =
    (veSql && !veSql.includes("'2k'")) ||
    !veColumns.includes('resolution_limit') ||
    /target_resolution\s+TEXT\s+NOT\s+NULL/i.test(veSql);
  if (needsRebuild) {
    console.log('[database] 迁移：video_enhancements 重建以支持自定义短边/全部预设档位...');
    db.exec(`
      ALTER TABLE video_enhancements RENAME TO video_enhancements_old;
      CREATE TABLE video_enhancements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        user_id INTEGER NOT NULL,
        project_id INTEGER,
        source_video_url TEXT NOT NULL,
        mediakit_task_id TEXT,
        tool_version TEXT NOT NULL DEFAULT 'standard' CHECK (tool_version IN ('standard', 'professional')),
        scene TEXT NOT NULL DEFAULT 'common' CHECK (scene IN ('aigc', 'short_series', 'ugc', 'old_film', 'common')),
        target_resolution TEXT,
        resolution_limit INTEGER,
        target_fps INTEGER NOT NULL DEFAULT 30,
        duration_seconds INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'error')),
        enhanced_video_url TEXT,
        result_resolution TEXT,
        result_fps INTEGER,
        credits_used INTEGER DEFAULT 0,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME,
        downloaded_at DATETIME,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO video_enhancements (
        id, task_id, user_id, project_id, source_video_url, mediakit_task_id,
        tool_version, scene, target_resolution,
        target_fps, duration_seconds, status,
        enhanced_video_url, result_resolution, result_fps,
        credits_used, error_message, created_at, finished_at
      )
      SELECT
        id, task_id, user_id, project_id, source_video_url, mediakit_task_id,
        tool_version, scene, target_resolution,
        COALESCE(target_fps, 30), duration_seconds, status,
        enhanced_video_url,
        ${veColumns.includes('result_resolution') ? 'result_resolution' : 'NULL'},
        ${veColumns.includes('result_fps') ? 'result_fps' : 'NULL'},
        credits_used, error_message, created_at, finished_at
      FROM video_enhancements_old;
      DROP TABLE video_enhancements_old;
      CREATE INDEX IF NOT EXISTS idx_video_enhancements_task ON video_enhancements(task_id);
      CREATE INDEX IF NOT EXISTS idx_video_enhancements_status ON video_enhancements(status);
      CREATE INDEX IF NOT EXISTS idx_video_enhancements_user ON video_enhancements(user_id);
    `);
    console.log('[database] 迁移完成：video_enhancements 已重建');
  } else {
    // 极少情况下表结构已大致正确，仅按需补列
    if (!veColumns.includes('target_fps')) {
      db.exec(`ALTER TABLE video_enhancements ADD COLUMN target_fps INTEGER NOT NULL DEFAULT 30`);
    }
    if (!veColumns.includes('result_resolution')) {
      db.exec(`ALTER TABLE video_enhancements ADD COLUMN result_resolution TEXT`);
    }
    if (!veColumns.includes('result_fps')) {
      db.exec(`ALTER TABLE video_enhancements ADD COLUMN result_fps INTEGER`);
    }
    if (!veColumns.includes('resolution_limit')) {
      db.exec(`ALTER TABLE video_enhancements ADD COLUMN resolution_limit INTEGER`);
    }
    if (!veColumns.includes('downloaded_at')) {
      db.exec(`ALTER TABLE video_enhancements ADD COLUMN downloaded_at DATETIME`);
    }
  }

  // 启动清理：删除「孤儿中转视频任务」——曾经删除 audio_generations 时未级联清掉 tasks 行,
  // 在 tasks 表里残留为 task_kind='audio_intermediate' 但已无 audio_generations 引用。
  // 现在 DELETE /api/audio-generations/:id 会同步删，所以这里只清扫历史残留即可。
  try {
    const orphanInfo = db.prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE task_kind = 'audio_intermediate'
         AND NOT EXISTS (SELECT 1 FROM audio_generations ag WHERE ag.task_id = tasks.id)`
    ).get();
    if (orphanInfo?.n > 0) {
      console.log(`[database] 清理孤儿中转视频任务 ${orphanInfo.n} 条（task_kind='audio_intermediate' 但 audio_generations 无引用）...`);
      const result = db.prepare(
        `DELETE FROM tasks
         WHERE task_kind = 'audio_intermediate'
           AND NOT EXISTS (SELECT 1 FROM audio_generations ag WHERE ag.task_id = tasks.id)`
      ).run();
      console.log(`[database] 已清理 ${result.changes} 条孤儿任务`);
    }
  } catch (e) {
    console.warn('[database] 孤儿中转视频任务清理失败（不阻塞启动）：', e.message);
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
