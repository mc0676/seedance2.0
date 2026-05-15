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
  // 重建条件（任一为真即重建）：
  //  - 仍存在 target_resolution NOT NULL（老 schema 强制非空，与自定义短边模式冲突）
  //  - 仍存在限制 IN ('720p','1080p','4k') 的旧 CHECK（不含 '2k'/'240p' 等新档位的扩展）
  //  - 缺少 resolution_limit 列
  // 不能用「veSql 不含 '2k'」作为单独条件——重建后新 schema 没有 CHECK，反复触发重建会无限循环。
  const hasRestrictiveResolutionCheck =
    /target_resolution\s+TEXT\s+NOT\s+NULL\s+CHECK/i.test(veSql) ||
    /CHECK\s*\(\s*target_resolution\s+IN\s*\([^)]*\)\s*\)/i.test(veSql);
  const needsRebuild =
    /target_resolution\s+TEXT\s+NOT\s+NULL/i.test(veSql) ||
    hasRestrictiveResolutionCheck ||
    !veColumns.includes('resolution_limit');
  if (needsRebuild) {
    console.log('[database] 迁移：video_enhancements 重建以支持自定义短边/全部预设档位...');
    // 保留原 sqlite_sequence「最高水位线」——重建会丢失它（INSERT SELECT 只把 seq 推到当前 max(id)）。
    // 如果不保留，下次 AUTOINCREMENT 可能给出已被 credit_locks 等审计表占用过的旧 id，触发 UNIQUE 冲突。
    // 同时考虑 credit_locks 残留：把 seq 抬到 max(自身 seq, credit_locks.enhancement_id, video_enhancements_old.id)
    const oldSeqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'video_enhancements'").get();
    const oldSeq = Number(oldSeqRow?.seq || 0);
    const maxOldId = Number(db.prepare('SELECT MAX(id) AS m FROM video_enhancements').get()?.m || 0);
    const maxLockedEnhId = Number(db.prepare(
      'SELECT MAX(enhancement_id) AS m FROM credit_locks WHERE enhancement_id IS NOT NULL'
    ).get()?.m || 0);
    const preservedSeq = Math.max(oldSeq, maxOldId, maxLockedEnhId);
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
        deleted_at DATETIME,
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
    // 把 sqlite_sequence 抬到原最高水位线，避免重建后 AUTOINCREMENT 给出已被审计表占用过的旧 id
    if (preservedSeq > 0) {
      db.prepare(
        `INSERT INTO sqlite_sequence (name, seq) VALUES ('video_enhancements', ?)
         ON CONFLICT(name) DO UPDATE SET seq = excluded.seq`
      ).run(preservedSeq);
      console.log(`[database] sqlite_sequence.video_enhancements.seq 保留为 ${preservedSeq}（原 seq=${oldSeq}, max(id)=${maxOldId}, max(credit_locks.enhancement_id)=${maxLockedEnhId}）`);
    }
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

  // 增量迁移：四张业务表加 deleted_at（软删时间戳）。
  // 下载管理 / 业务模块的「删除」行为改为 UPDATE deleted_at = CURRENT_TIMESTAMP，列表查询过滤 IS NULL。
  // 这样 credit_locks / usage_logs 等审计表的外键永远指向真实存在的行，对账可追溯。
  // 必须放在 video_enhancements 重建之后——否则 rebuild 创建的新表会重置该列。
  for (const table of ['tasks', 'image_records', 'audio_generations', 'video_enhancements']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes('deleted_at')) {
      console.log(`[database] 迁移：${table} 添加 deleted_at 列（软删支持）...`);
      db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at DATETIME`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_deleted_at ON ${table}(deleted_at)`);
    }
  }

  // 历史残留：曾经 DELETE /api/audio-generations/:id 直接硬删 audio_generations 行，
  // 但没顺手清掉 tasks 里关联的 task_kind='audio_intermediate' 行（FK CASCADE 是 tasks→audio_generations
  // 方向，不会反向触发）。这些孤儿 task 行已无 audio_generations 引用，对当前的软删模型来说应当被
  // 软删（deleted_at 标记）以从下载列表里隐去；保留行体让 credit_locks.task_id 仍指向真实存在的行。
  try {
    const orphanTasks = db.prepare(
      `SELECT id FROM tasks
       WHERE task_kind = 'audio_intermediate'
         AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM audio_generations ag WHERE ag.task_id = tasks.id)`
    ).all();
    if (orphanTasks.length > 0) {
      console.log(`[database] 软删孤儿中转视频任务 ${orphanTasks.length} 条（task_kind='audio_intermediate' 已无 audio_generations 引用）...`);
      const ids = orphanTasks.map((r) => r.id);
      db.prepare(
        `UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP
         WHERE id IN (${ids.map(() => '?').join(',')})`
      ).run(...ids);
      console.log(`[database] 已软删 ${orphanTasks.length} 条孤儿任务`);
    }
  } catch (e) {
    console.warn('[database] 孤儿中转视频任务软删失败（不阻塞启动）：', e.message);
  }

  // 注：credit_locks 是积分扣除的操作账本，每条 lock 都需要保留 enhancement_id / image_record_id
  // 以便对账（每个 id 的扣除记录都可追溯）。AUTOINCREMENT 已保证业务表 id 不会复用，
  // 即便业务行被删除，credit_locks 行的外键值也不会被未来新行撞 UNIQUE。
  // 因此这里不做任何 credit_locks 的清理/解绑，行内容完整保留。

  // 增量迁移：HappyHorse 视频生成模块（DashScope 异步轮询）
  // 1) credit_locks 加 task_happyhorse_id（UNIQUE 通过单独索引实现）
  // 2) 创建 tasks_happyhorse / model_pricing_happyhorse 表
  // 3) 写入 happyhorse_api_key 占位
  {
    const clCols = db.prepare("PRAGMA table_info(credit_locks)").all().map((c) => c.name);
    if (!clCols.includes('task_happyhorse_id')) {
      console.log('[database] 迁移：credit_locks 添加 task_happyhorse_id 列...');
      db.exec(`ALTER TABLE credit_locks ADD COLUMN task_happyhorse_id INTEGER`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_locks_task_happyhorse_id_unique
             ON credit_locks(task_happyhorse_id) WHERE task_happyhorse_id IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_credit_locks_happyhorse ON credit_locks(task_happyhorse_id)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks_happyhorse (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('t2v', 'i2v', 'r2v', 'video-edit')),
        model TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        ratio TEXT,
        duration INTEGER,
        resolution TEXT NOT NULL,
        media_json TEXT,
        watermark INTEGER DEFAULT 0,
        audio_setting TEXT,
        seed INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'error', 'canceled')),
        dashscope_task_id TEXT,
        request_id TEXT,
        video_url TEXT,
        video_path TEXT,
        download_status TEXT DEFAULT 'pending',
        download_path TEXT,
        downloaded_at DATETIME,
        result_duration REAL,
        result_output_duration REAL,
        result_input_duration REAL,
        result_resolution INTEGER,
        result_ratio TEXT,
        credits_used INTEGER DEFAULT 0,
        error_message TEXT,
        submitted_at DATETIME,
        completed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deleted_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_happyhorse_user ON tasks_happyhorse(user_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_happyhorse_project ON tasks_happyhorse(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_happyhorse_status ON tasks_happyhorse(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_happyhorse_dashscope ON tasks_happyhorse(dashscope_task_id);

      CREATE TABLE IF NOT EXISTS model_pricing_happyhorse (
        mode TEXT NOT NULL CHECK (mode IN ('t2v', 'i2v', 'r2v', 'video-edit')),
        resolution TEXT NOT NULL CHECK (resolution IN ('720P', '1080P')),
        credits_per_second INTEGER NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (mode, resolution)
      );
      INSERT OR IGNORE INTO model_pricing_happyhorse (mode, resolution, credits_per_second) VALUES
        ('t2v', '720P', 90), ('t2v', '1080P', 160),
        ('i2v', '720P', 90), ('i2v', '1080P', 160),
        ('r2v', '720P', 90), ('r2v', '1080P', 160),
        ('video-edit', '720P', 90), ('video-edit', '1080P', 160);

      INSERT OR IGNORE INTO system_config (key, value, description)
      VALUES ('happyhorse_api_key', '', 'HappyHorse (阿里云百炼 DashScope) API Key');
    `);
  }

  // 增量迁移：用户姓名 / 部门补填 Gate
  // 1) departments 字典表（模糊查询下拉的数据源；首次填非已知部门时 INSERT OR IGNORE 自动写入）
  // 2) users.name TEXT
  // 3) users.department_id INTEGER REFERENCES departments(id)
  //    历史曾短暂存在 users.department TEXT 列；如果检测到，把每行 TEXT 名字 INSERT OR IGNORE
  //    进 departments 表 → 把 id 写回 department_id → 删除老 TEXT 列
  {
    db.exec(`
      CREATE TABLE IF NOT EXISTS departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_departments_name ON departments(name);
    `);

    const uCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (!uCols.includes('name')) {
      console.log('[database] 迁移：users 添加 name 列...');
      db.exec(`ALTER TABLE users ADD COLUMN name TEXT`);
    }
    if (!uCols.includes('department_id')) {
      console.log('[database] 迁移：users 添加 department_id 列...');
      db.exec(`ALTER TABLE users ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_department_id ON users(department_id)`);

    // 老旧 TEXT 列回填 + 删除
    if (uCols.includes('department')) {
      console.log('[database] 迁移：把 users.department TEXT 转换为 department_id 外键...');
      const legacy = db.prepare(
        `SELECT id, department FROM users WHERE department IS NOT NULL AND TRIM(department) <> '' AND department_id IS NULL`
      ).all();
      // 先 SELECT 再 INSERT，避免 INSERT OR IGNORE 在 AUTOINCREMENT 下消耗 id（造成跳号）
      const findDept = db.prepare(`SELECT id FROM departments WHERE name = ?`);
      const insertDept = db.prepare(`INSERT INTO departments (name) VALUES (?)`);
      const updateUser = db.prepare(`UPDATE users SET department_id = ? WHERE id = ?`);
      const tx = db.transaction(() => {
        for (const u of legacy) {
          const name = String(u.department).trim();
          if (!name) continue;
          let row = findDept.get(name);
          if (!row) {
            const r = insertDept.run(name);
            row = { id: r.lastInsertRowid };
          }
          if (row?.id) updateUser.run(row.id, u.id);
        }
      });
      tx();
      // SQLite 3.35+ 支持 DROP COLUMN
      try {
        db.exec(`ALTER TABLE users DROP COLUMN department`);
        console.log('[database] 迁移完成：users.department TEXT 列已删除');
      } catch (e) {
        console.warn('[database] 删除 users.department 失败（SQLite 版本过旧？保留列不影响新逻辑）:', e.message);
      }
    }
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
