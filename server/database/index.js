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
  db.pragma('journal_mode = WAL');

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

  // 增量迁移：model_pricing_happyhorse 添加 model 列（存储完整模型名，如 happyhorse-1.0-t2v）
  // 必须在 HappyHorse 迁移块之前执行，否则 INSERT 会因 model 列不存在而失败
  {
    const mphColumns = db.prepare("PRAGMA table_info(model_pricing_happyhorse)").all().map(c => c.name);
    if (!mphColumns.includes('model')) {
      console.log('[database] 迁移：model_pricing_happyhorse 添加 model 列...');
      db.exec(`ALTER TABLE model_pricing_happyhorse ADD COLUMN model TEXT NOT NULL DEFAULT ''`);
      db.exec(`
        UPDATE model_pricing_happyhorse SET model = CASE mode
          WHEN 't2v' THEN 'happyhorse-1.0-t2v'
          WHEN 'i2v' THEN 'happyhorse-1.0-i2v'
          WHEN 'r2v' THEN 'happyhorse-1.0-r2v'
          WHEN 'video-edit' THEN 'happyhorse-1.0-video-edit'
        END
      `);
      console.log('[database] 迁移完成：model_pricing_happyhorse.model 已添加并回填');
    }
  }

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
        model TEXT NOT NULL DEFAULT '',
        resolution TEXT NOT NULL CHECK (resolution IN ('720P', '1080P')),
        credits_per_second INTEGER NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (mode, resolution)
      );
      INSERT OR IGNORE INTO model_pricing_happyhorse (mode, model, resolution, credits_per_second) VALUES
        ('t2v',    'happyhorse-1.0-t2v',        '720P',  90), ('t2v',    'happyhorse-1.0-t2v',        '1080P', 160),
        ('i2v',    'happyhorse-1.0-i2v',        '720P',  90), ('i2v',    'happyhorse-1.0-i2v',        '1080P', 160),
        ('r2v',    'happyhorse-1.0-r2v',        '720P',  90), ('r2v',    'happyhorse-1.0-r2v',        '1080P', 160),
        ('video-edit', 'happyhorse-1.0-video-edit', '720P',  90), ('video-edit', 'happyhorse-1.0-video-edit', '1080P', 160);

      INSERT OR IGNORE INTO system_config (key, value, description)
      VALUES ('happyhorse_api_key', '', 'HappyHorse (阿里云百炼 DashScope) API Key');
    `);
  }

  // model_discounting 折扣表（schema.sql 已定义，这里兜底创建）
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_discounting (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      sub_key TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('percent', 'number')),
      value REAL NOT NULL,
      start_date DATETIME NOT NULL,
      end_date DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (model, sub_key)
    );
  `);

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

    // 确保默认小组（id=0）存在
    db.exec(`INSERT OR IGNORE INTO departments (id, name) VALUES (0, '默认小组')`);

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

  // 增量迁移：消耗分析预聚合表（免去实时 GROUP BY 全表扫描）
  {
    const hasAnalyticsDaily = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_daily'")
      .get();
    if (!hasAnalyticsDaily) {
      console.log('[database] 迁移：创建 analytics_daily 预聚合表并回填历史数据...');
      db.exec(`
        CREATE TABLE analytics_daily (
          day TEXT PRIMARY KEY,
          consumed INTEGER DEFAULT 0,
          total_calls INTEGER DEFAULT 0,
          failed_calls INTEGER DEFAULT 0,
          wasted_credits INTEGER DEFAULT 0
        );
        CREATE INDEX idx_analytics_daily_day ON analytics_daily(day DESC);

        CREATE TABLE analytics_daily_users (
          day TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          PRIMARY KEY (day, user_id)
        );

        CREATE TRIGGER trg_usage_logs_analytics
        AFTER INSERT ON usage_logs
        BEGIN
          INSERT INTO analytics_daily (day, consumed, total_calls, failed_calls, wasted_credits)
          VALUES (
            date(NEW.created_at),
            CASE WHEN NEW.status = 'success' THEN NEW.credits_cost ELSE 0 END,
            1,
            CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
            CASE WHEN NEW.status = 'failed' THEN NEW.credits_cost ELSE 0 END
          )
          ON CONFLICT(day) DO UPDATE SET
            consumed      = consumed + CASE WHEN NEW.status = 'success' THEN NEW.credits_cost ELSE 0 END,
            total_calls   = total_calls + 1,
            failed_calls  = failed_calls + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
            wasted_credits = wasted_credits + CASE WHEN NEW.status = 'failed' THEN NEW.credits_cost ELSE 0 END;

          INSERT OR IGNORE INTO analytics_daily_users (day, user_id)
          VALUES (date(NEW.created_at), NEW.user_id);
        END;

        -- 回填历史汇总数据
        INSERT INTO analytics_daily (day, consumed, total_calls, failed_calls, wasted_credits)
        SELECT
          date(created_at) AS day,
          SUM(CASE WHEN status='success' THEN credits_cost ELSE 0 END),
          COUNT(*),
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),
          SUM(CASE WHEN status='failed' THEN credits_cost ELSE 0 END)
        FROM usage_logs
        WHERE created_at IS NOT NULL
        GROUP BY day
        ON CONFLICT(day) DO UPDATE SET
          consumed      = excluded.consumed,
          total_calls   = excluded.total_calls,
          failed_calls  = excluded.failed_calls,
          wasted_credits = excluded.wasted_credits;

        -- 回填历史每日活跃用户
        INSERT OR IGNORE INTO analytics_daily_users (day, user_id)
        SELECT DISTINCT date(created_at) AS day, user_id
        FROM usage_logs
        WHERE created_at IS NOT NULL;
      `);
      console.log('[database] 迁移完成：analytics_daily 预聚合表已创建并回填');
    }
    // 补充索引：加速失败分析查询（status + created_at 复合索引）
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_logs_status_created ON usage_logs(status, created_at DESC)`);
  }

  // 增量迁移：积分发放日志表（管理员发分统计）
  {
    const hasDistLogs = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credit_distribution_logs'")
      .get();
    if (!hasDistLogs) {
      console.log('[database] 迁移：创建 credit_distribution_logs 表...');
      db.exec(`
        CREATE TABLE credit_distribution_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          credits_amount INTEGER NOT NULL,
          method TEXT NOT NULL CHECK (method IN ('activation_code', 'manual_set', 'manual_add', 'checkin')),
          note TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_credit_dist_logs_admin ON credit_distribution_logs(admin_id, created_at DESC);
        CREATE INDEX idx_credit_dist_logs_recip ON credit_distribution_logs(recipient_id, created_at DESC);
        CREATE INDEX idx_credit_dist_logs_time ON credit_distribution_logs(created_at DESC);
      `);
      console.log('[database] 迁移完成：credit_distribution_logs 表已创建');
    }
  }

  // 增量迁移：管理员发分额度表（按管理员单独设置限额）
  {
    const hasAdminQuotas = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_quotas'")
      .get();
    if (!hasAdminQuotas) {
      console.log('[database] 迁移：创建 admin_quotas 表...');
      db.exec(`
        CREATE TABLE admin_quotas (
          admin_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          total_quota INTEGER NOT NULL DEFAULT 0,
          daily_quota INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('[database] 迁移完成：admin_quotas 表已创建');
    }
  }

  // 增量迁移：uploads 表（OSS 上传追踪）
  {
    const hasUploads = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='uploads'")
      .get();
    if (!hasUploads) {
      console.log('[database] 迁移：创建 uploads 表...');
      db.exec(`
        CREATE TABLE uploads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          original_name TEXT NOT NULL,
          oss_key TEXT NOT NULL UNIQUE,
          oss_url TEXT NOT NULL UNIQUE,
          media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'audio')),
          file_size INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_uploads_oss_key ON uploads(oss_key);
        CREATE INDEX IF NOT EXISTS idx_uploads_oss_url ON uploads(oss_url);
      `);
      console.log('[database] 迁移完成：uploads 表已创建');
    }
  }

  // 增量迁移：tasks / tasks_happyhorse 加 concurrent_id 列（批量生成批次 ID）
  for (const table of ['tasks', 'tasks_happyhorse']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes('concurrent_id')) {
      console.log(`[database] 迁移：${table} 添加 concurrent_id 列（批量生成批次 ID）...`);
      db.exec(`ALTER TABLE ${table} ADD COLUMN concurrent_id TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_concurrent_id ON ${table}(concurrent_id)`);
    }
  }

  // 增量迁移：项目组绑定 API 账户、Key组分组权重、资产归属
  // projects 加 volc_id
  {
    const pCols = db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
    if (!pCols.includes('volc_id')) {
      console.log('[database] 迁移：projects 添加 volc_id 列...');
      db.exec(`ALTER TABLE projects ADD COLUMN volc_id INTEGER REFERENCES volc_key_groups(id) ON DELETE SET NULL`);
      // 已有项目默认绑定 id=1
      db.exec(`UPDATE projects SET volc_id = 1 WHERE volc_id IS NULL`);
      console.log('[database] 迁移完成：projects.volc_id 已添加，已有项目已绑定默认 id=1');
    }
  }
  // volc_key_groups 加 grouping_weight
  {
    const vCols = db.prepare("PRAGMA table_info(volc_key_groups)").all().map((c) => c.name);
    if (!vCols.includes('grouping_weight')) {
      console.log('[database] 迁移：volc_key_groups 添加 grouping_weight 列...');
      db.exec(`ALTER TABLE volc_key_groups ADD COLUMN grouping_weight INTEGER DEFAULT 0`);
      // 默认 id=1 设置为 100%
      db.exec(`UPDATE volc_key_groups SET grouping_weight = 100 WHERE id = 1 AND is_active = 1`);
      console.log('[database] 迁移完成：volc_key_groups.grouping_weight 已添加');
    }
  }
  // asset_groups 加 volc_id
  {
    const agCols = db.prepare("PRAGMA table_info(asset_groups)").all().map((c) => c.name);
    if (!agCols.includes('volc_id')) {
      console.log('[database] 迁移：asset_groups 添加 volc_id 列...');
      db.exec(`ALTER TABLE asset_groups ADD COLUMN volc_id INTEGER`);
      // 如果存在旧列 volc_key_group_id 则迁移数据
      if (agCols.includes('volc_key_group_id')) {
        db.exec(`UPDATE asset_groups SET volc_id = volc_key_group_id WHERE volc_key_group_id IS NOT NULL`);
      }
      console.log('[database] 迁移完成：asset_groups.volc_id 已添加');
    }
    if (!agCols.includes('thumbnail_oss_url')) {
      console.log('[database] 迁移：asset_groups 添加 thumbnail_oss_url 列...');
      db.exec(`ALTER TABLE asset_groups ADD COLUMN thumbnail_oss_url TEXT`);
      console.log('[database] 迁移完成：asset_groups.thumbnail_oss_url 已添加');
    }
  }
  // project_assets 加 volc_id
  {
    const paCols = db.prepare("PRAGMA table_info(project_assets)").all().map((c) => c.name);
    if (!paCols.includes('volc_id')) {
      console.log('[database] 迁移：project_assets 添加 volc_id 列...');
      db.exec(`ALTER TABLE project_assets ADD COLUMN volc_id INTEGER`);
      // 如果存在旧列 volc_key_group_id 则迁移数据
      if (paCols.includes('volc_key_group_id')) {
        db.exec(`UPDATE project_assets SET volc_id = volc_key_group_id WHERE volc_key_group_id IS NOT NULL`);
      }
      console.log('[database] 迁移完成：project_assets.volc_id 已添加');
    }
  }

  // 增量迁移：activation_codes 加 is_credit_daily / time_of_expiration
  {
    const acCols = db.prepare("PRAGMA table_info(activation_codes)").all().map((c) => c.name);
    if (!acCols.includes('is_credit_daily')) {
      console.log('[database] 迁移：activation_codes 添加 is_credit_daily / time_of_expiration 列...');
      db.exec(`ALTER TABLE activation_codes ADD COLUMN is_credit_daily INTEGER`);
      db.exec(`ALTER TABLE activation_codes ADD COLUMN time_of_expiration DATETIME`);
      console.log('[database] 迁移完成：activation_codes.is_credit_daily / time_of_expiration 已添加');
    }
  }

  // 增量迁移：image_records 加 wuyin_task_id
  {
    const irCols = db.prepare("PRAGMA table_info(image_records)").all().map((c) => c.name);
    if (!irCols.includes('wuyin_task_id')) {
      console.log('[database] 迁移：image_records 添加 wuyin_task_id 列...');
      db.exec(`ALTER TABLE image_records ADD COLUMN wuyin_task_id TEXT`);
      console.log('[database] 迁移完成：image_records.wuyin_task_id 已添加');
    }
  }

  // 增量迁移：credit_distribution_logs 扩展 method CHECK 约束，加入 self_paying / code_refund
  {
    const colInfo = db.prepare("PRAGMA table_info(credit_distribution_logs)").all();
    if (colInfo.length > 0) {
      // SQLite 不支持 ALTER CHECK，只能重建表
      const needMigrate = !db.prepare("SELECT COUNT(*) AS c FROM credit_distribution_logs WHERE method = 'self_paying'").get(); // 如果 self_paying 能查询成功说明约束已更新
      // 更稳健的方式：直接尝试插入 self_paying 的记录，失败则重建
      let constraintOk = false;
      try {
        db.prepare("INSERT INTO credit_distribution_logs (admin_id, recipient_id, credits_amount, method, note) VALUES (NULL, 1, 0, 'self_paying', '__migrate_test__')").run();
        db.prepare("DELETE FROM credit_distribution_logs WHERE note = '__migrate_test__'").run();
        constraintOk = true;
      } catch (e) {
        constraintOk = false;
      }
      if (!constraintOk) {
        console.log('[database] 迁移：credit_distribution_logs 扩展 method CHECK 约束...');
        // 检测当前表中是否已有 amount_of_taking_back 列（后续迁移可能已添加）
        const hasAOTB = db.prepare("PRAGMA table_info(credit_distribution_logs)").all().some(c => c.name === 'amount_of_taking_back');
        db.exec('BEGIN');
        if (hasAOTB) {
          db.exec(`
            CREATE TABLE credit_distribution_logs_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
              recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              credits_amount INTEGER NOT NULL,
              method TEXT NOT NULL CHECK (method IN ('activation_code','manual_set','manual_add','checkin','self_paying','code_refund')),
              note TEXT DEFAULT '',
              amount_of_taking_back INTEGER,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `);
          db.exec('INSERT INTO credit_distribution_logs_new (id, admin_id, recipient_id, credits_amount, method, note, amount_of_taking_back, created_at) SELECT id, admin_id, recipient_id, credits_amount, method, note, amount_of_taking_back, created_at FROM credit_distribution_logs');
        } else {
          db.exec(`
            CREATE TABLE credit_distribution_logs_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
              recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              credits_amount INTEGER NOT NULL,
              method TEXT NOT NULL CHECK (method IN ('activation_code','manual_set','manual_add','checkin','self_paying','code_refund')),
              note TEXT DEFAULT '',
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `);
          db.exec('INSERT INTO credit_distribution_logs_new SELECT * FROM credit_distribution_logs');
        }
        db.exec('DROP TABLE credit_distribution_logs');
        db.exec('ALTER TABLE credit_distribution_logs_new RENAME TO credit_distribution_logs');
        db.exec('CREATE INDEX IF NOT EXISTS idx_cdl_admin ON credit_distribution_logs(admin_id, created_at DESC)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_cdl_recipient ON credit_distribution_logs(recipient_id, created_at DESC)');
        db.exec('COMMIT');
        console.log('[database] 迁移完成：credit_distribution_logs.method 约束已扩展');
      }
    }
  }

  // 增量迁移：credit_distribution_logs 添加 amount_of_taking_back 字段
  {
    const cdlCols = db.prepare("PRAGMA table_info(credit_distribution_logs)").all().map((c) => c.name);
    if (!cdlCols.includes('amount_of_taking_back')) {
      console.log('[database] 迁移：credit_distribution_logs 添加 amount_of_taking_back 列...');
      db.exec('ALTER TABLE credit_distribution_logs ADD COLUMN amount_of_taking_back INTEGER DEFAULT 0');
      // 扩展 method CHECK 约束，加入 recycling
      db.exec("CREATE TABLE cdl_tmp AS SELECT * FROM credit_distribution_logs");
      db.exec("DROP TABLE credit_distribution_logs");
      db.exec(`CREATE TABLE credit_distribution_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL, recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, credits_amount INTEGER NOT NULL, method TEXT NOT NULL CHECK (method IN ('activation_code','activation_code_daily','manual_set','manual_add','checkin','self_paying','code_refund','recycling')), note TEXT DEFAULT '', amount_of_taking_back INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.exec("INSERT INTO credit_distribution_logs (id, admin_id, recipient_id, credits_amount, method, note, created_at, amount_of_taking_back) SELECT id, admin_id, recipient_id, credits_amount, method, note, created_at, amount_of_taking_back FROM cdl_tmp");
      db.exec("DROP TABLE cdl_tmp");
      db.exec("CREATE INDEX IF NOT EXISTS idx_cdl_admin ON credit_distribution_logs(admin_id, created_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_cdl_recipient ON credit_distribution_logs(recipient_id, created_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_cdl_time ON credit_distribution_logs(created_at DESC)");
      console.log('[database] 迁移完成：credit_distribution_logs.amount_of_taking_back 已添加');
    }
  }

  // 修正迁移：修复列顺序错乱导致 amount_of_taking_back 被写入日期值的问题
  {
    const cdlCols = db.prepare("PRAGMA table_info(credit_distribution_logs)").all().map((c) => c.name);
    if (cdlCols.includes('amount_of_taking_back')) {
      // 检查是否有 amount_of_taking_back 值异常大（日期值 > 1000000）
      const badRows = db.prepare("SELECT COUNT(*) AS c FROM credit_distribution_logs WHERE amount_of_taking_back > 1000000").get();
      if (badRows && badRows.c > 0) {
        console.log(`[database] 修正迁移：检测到 ${badRows.c} 条 amount_of_taking_back 异常数据，正在修复...`);
        // amount_of_taking_back 里存的是日期（created_at），created_at 里存的是 0
        // 交换回来：同时修正两列
        db.prepare("UPDATE credit_distribution_logs SET created_at = amount_of_taking_back, amount_of_taking_back = 0 WHERE amount_of_taking_back > 1000000").run();
        console.log('[database] 修正迁移完成：列顺序已修复');
      }
    }
  }

  // 增量迁移：credit_distribution_logs.method CHECK 加入 activation_code_daily
  {
    const cdlSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='credit_distribution_logs'").get()?.sql || '';
    if (cdlSQL && !cdlSQL.includes('activation_code_daily')) {
      console.log('[database] 迁移：credit_distribution_logs.method CHECK 加入 activation_code_daily...');
      db.exec("CREATE TABLE cdl_tmp2 AS SELECT * FROM credit_distribution_logs");
      db.exec("DROP TABLE credit_distribution_logs");
      db.exec(`CREATE TABLE credit_distribution_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL, recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, credits_amount INTEGER NOT NULL, method TEXT NOT NULL CHECK (method IN ('activation_code','activation_code_daily','manual_set','manual_add','checkin','self_paying','code_refund','recycling')), note TEXT DEFAULT '', amount_of_taking_back INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.exec("INSERT INTO credit_distribution_logs SELECT * FROM cdl_tmp2");
      db.exec("DROP TABLE cdl_tmp2");
      db.exec("CREATE INDEX IF NOT EXISTS idx_cdl_admin ON credit_distribution_logs(admin_id, created_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_cdl_recipient ON credit_distribution_logs(recipient_id, created_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_cdl_time ON credit_distribution_logs(created_at DESC)");
      console.log('[database] 迁移完成：activation_code_daily 已加入 CHECK');
    }
  }

  // 增量迁移：为 image_records / audio_generations / video_enhancements 添加 download_status
  {
    const tables = ['image_records', 'audio_generations', 'video_enhancements'];
    for (const tbl of tables) {
      const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map((c) => c.name);
      if (!cols.includes('download_status')) {
        console.log(`[database] 迁移：${tbl} 添加 download_status 列...`);
        db.exec(`ALTER TABLE ${tbl} ADD COLUMN download_status TEXT NOT NULL DEFAULT 'pending'`);
        console.log(`[database] 迁移完成：${tbl}.download_status 已添加`);
      }
    }
  }

  // 增量迁移：DeepSeek 对话 + 消息表
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks_texts_dialogue'").get()) {
    db.exec(`CREATE TABLE tasks_texts_dialogue (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      name TEXT NOT NULL DEFAULT '新对话',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_dialogue_user ON tasks_texts_dialogue(user_id, created_at DESC)');
    console.log('[database] 迁移：tasks_texts_dialogue 表已创建');
  }
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks_text'").get()) {
    db.exec(`CREATE TABLE tasks_text (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_of_dialogue TEXT NOT NULL REFERENCES tasks_texts_dialogue(id) ON DELETE CASCADE,
      model TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
      messages_in_once TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','error')),
      tokens_prompt INTEGER DEFAULT 0,
      tokens_completion INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_text_dialogue ON tasks_text(id_of_dialogue, created_at ASC)');
    console.log('[database] 迁移：tasks_text 表已创建');
  }
  // 确保 DeepSeek 配置项存在（老数据库可能缺少）
  db.prepare("INSERT OR IGNORE INTO system_config (key, value, description) VALUES ('deepseek_api_key', '', 'DeepSeek Chat API Key')").run();
  db.prepare("INSERT OR IGNORE INTO system_config (key, value, description) VALUES ('deepseek_model', 'deepseek-v4-flash', 'DeepSeek 默认模型')").run();
  db.prepare("INSERT OR IGNORE INTO system_config (key, value, description) VALUES ('deepseek_reasoning_effort', 'high', 'DeepSeek 推理深度（low/medium/high/max）')").run();

  // 无限画布表 — CREATE IF NOT EXISTS（不重复重建，保留数据）
  {
    db.exec(`CREATE TABLE IF NOT EXISTS canvas__cloths (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '未命名画布',
      viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"k":1}',
      background_mode TEXT NOT NULL DEFAULT 'lines',
      show_image_info INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_canvas__cloths_user ON canvas__cloths(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_canvas__cloths_project ON canvas__cloths(project_id, updated_at DESC)');

    db.exec(`CREATE TABLE IF NOT EXISTS canvas__clothses_assets (
      id TEXT PRIMARY KEY, id_of_cloth TEXT NOT NULL REFERENCES canvas__cloths(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('video','image','audio','enhancement','script','imagine_of_volc','config')),
      subtype TEXT, id_of_resource INTEGER, title TEXT NOT NULL DEFAULT '',
      pos_x REAL NOT NULL DEFAULT 0, pos_y REAL NOT NULL DEFAULT 0,
      width REAL NOT NULL DEFAULT 200, height REAL NOT NULL DEFAULT 120,
      metadata TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_clothses_assets_cloth ON canvas__clothses_assets(id_of_cloth)');

    db.exec(`CREATE TABLE IF NOT EXISTS canvas__clothses_connections (
      id TEXT PRIMARY KEY, id_of_cloth TEXT NOT NULL REFERENCES canvas__cloths(id) ON DELETE CASCADE,
      from_asset_id TEXT NOT NULL REFERENCES canvas__clothses_assets(id) ON DELETE CASCADE,
      to_asset_id TEXT NOT NULL REFERENCES canvas__clothses_assets(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_clothses_conn_cloth ON canvas__clothses_connections(id_of_cloth)');

    db.exec(`CREATE TABLE IF NOT EXISTS canvas__scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, title TEXT,
      content TEXT NOT NULL DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_canvas__scripts_user ON canvas__scripts(user_id, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_canvas__scripts_project ON canvas__scripts(project_id, created_at DESC)');

    db.exec(`CREATE TABLE IF NOT EXISTS canvas__configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL DEFAULT 0 REFERENCES projects(id) ON DELETE CASCADE,
      generation_mode TEXT NOT NULL DEFAULT 'image',
      model TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      params TEXT NOT NULL DEFAULT '{}',
      assets_of_at TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_canvas__configs_project ON canvas__configs(project_id)');

    db.exec(`CREATE TABLE IF NOT EXISTS canvas__settings (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      description TEXT,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
    )`);
    db.exec(`INSERT OR IGNORE INTO canvas__settings (key, value, description) VALUES ('image_models', '["nano-banana-2","gpt-image-2"]', '图片模型列表')`);
    db.exec(`INSERT OR IGNORE INTO canvas__settings (key, value, description) VALUES ('image_default', 'nano-banana-2', '默认图片模型')`);
    db.exec(`INSERT OR IGNORE INTO canvas__settings (key, value, description) VALUES ('video_models', '["seedance-2.0","seedance-2.0-fast","happyhorse-1.0-t2v"]', '视频模型列表')`);
    db.exec(`INSERT OR IGNORE INTO canvas__settings (key, value, description) VALUES ('video_default', 'seedance-2.0', '默认视频模型')`);
    db.exec(`INSERT OR IGNORE INTO canvas__settings (key, value, description) VALUES ('theme', 'dark', '主题：dark | light')`);
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