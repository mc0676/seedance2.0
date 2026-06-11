-- Seedance 2.0 批量管理功能数据库 Schema

-- ============================================
-- 用户认证模块表结构（参考 genai-craft）
-- ============================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin', 'super_admin')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  credits INTEGER DEFAULT 10,
  unlimited_credits INTEGER DEFAULT 0,
  daily_check_in INTEGER DEFAULT 0,
  last_check_in_at DATETIME,
  name TEXT,                                     -- 用户姓名（首次登录需补填）
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,  -- 部门外键（首次登录需补填；仅管理员可改）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_department_id ON users(department_id);

-- 部门字典表（模糊查询下拉的数据源；新建部门时 INSERT OR IGNORE 写入；users.department_id 引用此表）
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_departments_name ON departments(name);

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 签到记录表
CREATE TABLE IF NOT EXISTS check_ins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  credits_earned INTEGER DEFAULT 2,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 邮箱验证码表（增强版，支持防刷和多种用途）
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT DEFAULT 'register' CHECK (purpose IN ('register', 'login', 'reset_password', 'bind_email')),
  code_hash TEXT NOT NULL, -- 加密存储验证码
  salt TEXT NOT NULL,
  attempts INTEGER DEFAULT 0, -- 验证尝试次数
  request_ip TEXT, -- 请求 IP（用于防刷）
  consumed_at DATETIME, -- 已使用/已消费时间
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 系统配置表（用于存储 SMTP 等配置）
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  description TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_email_verification_codes_email ON email_verification_codes(email);
CREATE INDEX IF NOT EXISTS idx_email_verification_codes_expires_at ON email_verification_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_email_verification_codes_purpose ON email_verification_codes(purpose, email);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);


-- 插入默认管理员账户 (密码：yunyu512@)
INSERT OR IGNORE INTO users (email, password_hash, role, status, credits)
VALUES ('admin@yunyu512.top', 'e23b83f0e848670e882ff2d34e67a3cb218c84f6b420e737eea1af79ee45b441', 'super_admin', 'active', 1000);

-- ============================================
-- 原有业务表结构
-- ============================================

-- 项目表
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  settings_json TEXT,
  video_save_path TEXT,
  default_concurrent INTEGER DEFAULT 5,
  default_min_interval INTEGER DEFAULT 30000,
  default_max_interval INTEGER DEFAULT 50000,
  volc_id INTEGER REFERENCES volc_key_groups(id) ON DELETE SET NULL
);

-- 任务表
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  ratio TEXT,
  duration TEXT,
  resolution TEXT,
  status TEXT DEFAULT 'pending',
  submit_id TEXT,
  history_id TEXT,
  item_id TEXT,
  video_url TEXT,
  video_path TEXT,
  download_status TEXT DEFAULT 'pending',
  download_path TEXT,
  downloaded_at DATETIME,
  submitted_at DATETIME,
  account_info TEXT,
  progress TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  task_kind TEXT NOT NULL DEFAULT 'video' CHECK (task_kind IN ('video', 'audio_intermediate')),
  deleted_at DATETIME, -- 软删时间戳；NULL = 未删除，所有用户可见查询应过滤 WHERE deleted_at IS NULL
  downloadable INTEGER DEFAULT 1, -- [已废弃] 改用 deleted_at IS NULL 统一判断可见性
  concurrent_id TEXT, -- 批量生成批次 ID（同一批次的任务共享此 UUID）
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 项目成员表
CREATE TABLE IF NOT EXISTS project_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  invited_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
);

-- 使用量日志
CREATE TABLE IF NOT EXISTS usage_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  task_id       INTEGER,
  model         TEXT NOT NULL,
  action        TEXT NOT NULL DEFAULT 'generate_video',
  credits_cost  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'success',
  error_message TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_task_id ON usage_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at DESC);

-- 消耗分析预聚合表（由触发器自动维护，免去实时 GROUP BY 全表扫描）
CREATE TABLE IF NOT EXISTS analytics_daily (
  day           TEXT PRIMARY KEY,   -- 'YYYY-MM-DD'
  consumed      INTEGER DEFAULT 0,
  total_calls   INTEGER DEFAULT 0,
  failed_calls  INTEGER DEFAULT 0,
  wasted_credits INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_day ON analytics_daily(day DESC);

-- 每日活跃用户辅助表（触发器维护唯一用户-日对）
CREATE TABLE IF NOT EXISTS analytics_daily_users (
  day     TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (day, user_id)
);

-- usage_logs 写入触发器 → 自动增量更新预聚合
CREATE TRIGGER IF NOT EXISTS trg_usage_logs_analytics
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

-- 历史数据回填（已有数据一次性写入预聚合表）
INSERT OR IGNORE INTO analytics_daily (day, consumed, total_calls, failed_calls, wasted_credits)
SELECT
  date(created_at) AS day,
  SUM(CASE WHEN status = 'success' THEN credits_cost ELSE 0 END) AS consumed,
  COUNT(*) AS total_calls,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_calls,
  SUM(CASE WHEN status = 'failed' THEN credits_cost ELSE 0 END) AS wasted_credits
FROM usage_logs
GROUP BY day
ON CONFLICT(day) DO UPDATE SET
  consumed      = excluded.consumed,
  total_calls   = excluded.total_calls,
  failed_calls  = excluded.failed_calls,
  wasted_credits = excluded.wasted_credits;

-- 回填用户活跃度
INSERT OR IGNORE INTO analytics_daily_users (day, user_id)
SELECT DISTINCT date(created_at) AS day, user_id
FROM usage_logs;

-- 任务素材表
CREATE TABLE IF NOT EXISTS task_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  asset_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  image_uri TEXT,
  original_name TEXT,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- 生成历史表
CREATE TABLE IF NOT EXISTS generation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  batch_id TEXT, -- 批次 ID
  request_data TEXT, -- 请求参数
  response_data TEXT, -- 响应结果
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- 用户的即梦 SessionID 账号表
CREATE TABLE IF NOT EXISTS jimeng_session_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT DEFAULT '',
  session_id TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  is_enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, session_id)
);

-- 全局设置表
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);




-- 创建索引
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_download_status ON tasks(download_status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_download ON tasks(status, download_status);
CREATE INDEX IF NOT EXISTS idx_tasks_history_id ON tasks(history_id);
CREATE INDEX IF NOT EXISTS idx_tasks_item_id ON tasks(item_id);
CREATE INDEX IF NOT EXISTS idx_tasks_submit_id ON tasks(submit_id);
CREATE INDEX IF NOT EXISTS idx_tasks_concurrent_id ON tasks(concurrent_id);
CREATE INDEX IF NOT EXISTS idx_task_assets_task_id ON task_assets(task_id);
CREATE INDEX IF NOT EXISTS idx_generation_history_task_id ON generation_history(task_id);
CREATE INDEX IF NOT EXISTS idx_jimeng_session_accounts_user_id ON jimeng_session_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jimeng_session_accounts_default_per_user
  ON jimeng_session_accounts(user_id)
  WHERE is_default = 1;

-- 初始化默认设置
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('model', 'seedance-2.0-fast'),
  ('ratio', '9:16'),
  ('duration', '4'),
  ('reference_mode', '全能参考'),
  ('download_path', ''),
  ('max_concurrent', '5'),
  ('min_interval', '30000'),
  ('max_interval', '50000'),
  ('session_id', '');

-- 用户权限表
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id     INTEGER NOT NULL,
  feature_key TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by  INTEGER,
  PRIMARY KEY (user_id, feature_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_permissions_feature
  ON user_permissions(feature_key, enabled);

INSERT OR IGNORE INTO system_config (key, value, description)
VALUES
  ('default_user_permissions',
   '{"generate_video_seedance": true}',
   '新注册用户默认开启的功能权限（JSON）');

-- 模型 token 计费表
CREATE TABLE IF NOT EXISTS model_pricing (
  model_key            TEXT PRIMARY KEY,
  label                TEXT NOT NULL,
  price_no_video_low   REAL NOT NULL DEFAULT 0,
  price_no_video_high  REAL NOT NULL DEFAULT 0,
  price_with_video_low REAL NOT NULL DEFAULT 0,
  price_with_video_high REAL NOT NULL DEFAULT 0,
  price_audio          REAL NOT NULL DEFAULT 0,
  price_silent         REAL NOT NULL DEFAULT 0,
  draft_factor_audio   REAL NOT NULL DEFAULT 0.6,
  draft_factor_silent  REAL NOT NULL DEFAULT 0.7,
  pricing_type         TEXT NOT NULL DEFAULT 'seedance2' CHECK (pricing_type IN ('seedance2', 'seedance15')),
  default_fps          INTEGER NOT NULL DEFAULT 24,
  enabled              INTEGER NOT NULL DEFAULT 1,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  description          TEXT,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_model_pricing_enabled ON model_pricing(enabled, sort_order);

INSERT OR IGNORE INTO model_pricing
  (model_key, label, pricing_type,
   price_no_video_low, price_no_video_high, price_with_video_low, price_with_video_high,
   price_audio, price_silent, draft_factor_audio, draft_factor_silent,
   default_fps, enabled, sort_order, description) VALUES
  ('seedance-2.0',          'Seedance 2.0 全能',         'seedance2', 46, 51, 28, 31,  0,    0,    0.6, 0.7, 24, 1, 10, '480/720/1080p 全能模型；输入含视频时单价较低'),
  ('seedance-2.0-fast',     'Seedance 2.0 Fast',         'seedance2', 37, 0,  22, 0,   0,    0,    0.6, 0.7, 24, 1, 30, 'Fast 模型不支持 1080p');

-- 账号级模型权限表（per API Key 控制可用模型；无行时默认启用）
CREATE TABLE IF NOT EXISTS account_model_permissions (
  account_id  INTEGER NOT NULL,
  model_key   TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by  INTEGER,
  PRIMARY KEY (account_id, model_key),
  FOREIGN KEY (account_id) REFERENCES jimeng_session_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_amp_account ON account_model_permissions(account_id);

-- 资产库 asset_groups 表（每个项目一个资产组）
CREATE TABLE IF NOT EXISTS asset_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  volc_group_id TEXT,
  volc_id INTEGER,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  thumbnail_oss_url TEXT,  -- 压缩封面图OSS永久URL（浏览器压缩后上传，避免实时拉火山API）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 资产表（项目资产库中的单个素材）
CREATE TABLE IF NOT EXISTS project_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  asset_group_id INTEGER,
  volc_asset_id TEXT,
  volc_id INTEGER,
  name TEXT NOT NULL,
  original_name TEXT,
  description TEXT DEFAULT '',
  file_type TEXT NOT NULL DEFAULT 'image',
  file_size INTEGER DEFAULT 0,
  file_url TEXT,
  thumbnail_url TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'active', 'rejected', 'deleted')),
  review_status TEXT DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  auto_inject INTEGER DEFAULT 0,
  uploaded_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_group_id) REFERENCES asset_groups(id) ON DELETE SET NULL,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_project_assets_project_id ON project_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_assets_status ON project_assets(status);
CREATE INDEX IF NOT EXISTS idx_project_assets_auto_inject ON project_assets(project_id, auto_inject, review_status);

-- 积分锁定表（task_id 用于视频任务，image_record_id 用于图片任务，两者互斥）
CREATE TABLE IF NOT EXISTS credit_locks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL,
  task_id            INTEGER UNIQUE,
  image_record_id    INTEGER UNIQUE,
  enhancement_id     INTEGER UNIQUE,
  task_happyhorse_id INTEGER UNIQUE,
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
CREATE INDEX IF NOT EXISTS idx_credit_locks_user_status ON credit_locks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_credit_locks_task ON credit_locks(task_id);
CREATE INDEX IF NOT EXISTS idx_credit_locks_image ON credit_locks(image_record_id);
CREATE INDEX IF NOT EXISTS idx_credit_locks_enhancement ON credit_locks(enhancement_id);
CREATE INDEX IF NOT EXISTS idx_credit_locks_happyhorse ON credit_locks(task_happyhorse_id);

-- HappyHorse 视频任务（DashScope 异步轮询，4 个子模式共用一张表）
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
  media_json TEXT,                      -- JSON: [{type, url, original_name?}]
  watermark INTEGER DEFAULT 0,          -- 强制不加水印（产品决策）
  audio_setting TEXT,                   -- 仅 video-edit：'auto' | 'origin'
  seed INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'error', 'canceled')),
  dashscope_task_id TEXT,
  request_id TEXT,
  video_url TEXT,                       -- DashScope 临时 URL（24h）
  video_path TEXT,
  download_status TEXT DEFAULT 'pending',
  download_path TEXT,
  downloaded_at DATETIME,
  result_duration REAL,                 -- usage.duration（用于计费）
  result_output_duration REAL,
  result_input_duration REAL,
  result_resolution INTEGER,            -- usage.SR
  result_ratio TEXT,
  credits_used INTEGER DEFAULT 0,
  error_message TEXT,
  submitted_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  downloadable INTEGER DEFAULT 1, -- [已废弃] 改用 deleted_at IS NULL 统一判断可见性
  concurrent_id TEXT, -- 批量生成批次 ID（同一批次的任务共享此 UUID）
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_happyhorse_user ON tasks_happyhorse(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_happyhorse_project ON tasks_happyhorse(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_happyhorse_status ON tasks_happyhorse(status);
CREATE INDEX IF NOT EXISTS idx_tasks_happyhorse_dashscope ON tasks_happyhorse(dashscope_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_happyhorse_concurrent_id ON tasks_happyhorse(concurrent_id);

-- HappyHorse 计费表（mode × resolution → 积分/秒），命名沿用 model_pricing_* 规范
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

INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('happyhorse_api_key', '', 'HappyHorse (阿里云百炼 DashScope) API Key');

INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('bss_access_key_id', '', '阿里云 BSS AccessKey ID（查询账户余额）'),
  ('bss_access_key_secret', '', '阿里云 BSS AccessKey Secret（查询账户余额）');

-- 模型折扣管理（支持模型计费 + HappyHorse 计费）
-- model: model_key（模型计费）或 mode（HappyHorse），始终为具体值，不使用通配符
-- sub_key: 定价字段名如 price_no_video_low（模型计费）或分辨率如 720P（HappyHorse）
-- type: percent=按比例折扣 / number=按绝对价格
-- UNIQUE(model, sub_key) 保证同一目标不会出现两个折扣
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

-- 视频画质增强（火山 AI MediaKit）
CREATE TABLE IF NOT EXISTS video_enhancements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  user_id INTEGER NOT NULL,
  project_id INTEGER,
  source_video_url TEXT NOT NULL,
  mediakit_task_id TEXT,
  tool_version TEXT NOT NULL DEFAULT 'standard' CHECK (tool_version IN ('standard', 'professional')),
  scene TEXT NOT NULL DEFAULT 'common' CHECK (scene IN ('aigc', 'short_series', 'ugc', 'old_film', 'common')),
  -- target_resolution / resolution_limit 二选一（MediaKit 互斥参数）
  --   target_resolution：预设档位（240p/360p/480p/540p/720p/1080p/2k/4k）
  --   resolution_limit：短边像素精确值 [64, 2160]，等比缩放
  target_resolution TEXT,
  resolution_limit INTEGER,
  target_fps INTEGER NOT NULL DEFAULT 30,
  duration_seconds INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'error')),
  enhanced_video_url TEXT,
  result_resolution TEXT,
  result_fps INTEGER,
  credits_used INTEGER DEFAULT 0,
  download_status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  downloaded_at DATETIME,
  deleted_at DATETIME, -- 软删时间戳；NULL = 未删除
  downloadable INTEGER DEFAULT 1, -- [已废弃] 改用 deleted_at IS NULL 统一判断可见性
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_enhancements_task ON video_enhancements(task_id);
CREATE INDEX IF NOT EXISTS idx_video_enhancements_status ON video_enhancements(status);
CREATE INDEX IF NOT EXISTS idx_video_enhancements_user ON video_enhancements(user_id);

-- 音频生成记录（参考图 + 语气提示词 → 4s seedance 视频 → 浏览器端转 mp3）
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
  download_status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  downloaded_at DATETIME,
  deleted_at DATETIME, -- 软删时间戳；NULL = 未删除
  downloadable INTEGER DEFAULT 1, -- [已废弃] 改用 deleted_at IS NULL 统一判断可见性
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_audio_generations_user ON audio_generations(user_id);
CREATE INDEX IF NOT EXISTS idx_audio_generations_status ON audio_generations(status);
CREATE INDEX IF NOT EXISTS idx_audio_generations_task ON audio_generations(task_id);

-- 画质增强基础单价
-- 单一可调旋钮：积分/分钟。系数表（标准版/专业版 × 720p/1080p/2k/4k × ≤30/>30fps）
-- 写在代码 enhancementPricingService.js，与 MediaKit 官方计费规则一致，不入库。
-- 默认 75 = 0.75 元/分钟 × 100 积分/元；管理员可在「画质增强基础单价」卡片调整。
INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('enhancement_base_credits_per_minute', '75', '画质增强基础单价（积分/分钟）');

-- 激活码表
CREATE TABLE IF NOT EXISTS activation_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  credits_value INTEGER DEFAULT 0,
  ark_api_key TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  is_credit_daily INTEGER,                 -- 1=每日积分（从管理员每日额度扣除），null/0=管理员账户积分
  time_of_expiration DATETIME,           -- 每日积分的截至日期（is_credit_daily=1 时有效）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 积分发放日志表（管理员发分统计）
CREATE TABLE IF NOT EXISTS credit_distribution_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits_amount INTEGER NOT NULL,
  amount_of_taking_back INTEGER,
  method TEXT NOT NULL CHECK (method IN ('activation_code', 'activation_code_daily', 'manual_set', 'manual_add', 'checkin', 'self_paying', 'code_refund', 'recycling')),
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_credit_dist_logs_admin ON credit_distribution_logs(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_dist_logs_recip ON credit_distribution_logs(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_dist_logs_time ON credit_distribution_logs(created_at DESC);

-- 管理员发分额度表（按管理员单独设置限额，0=不限制）
CREATE TABLE IF NOT EXISTS admin_quotas (
  admin_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_quota INTEGER NOT NULL DEFAULT 0,
  daily_quota INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- OSS 上传记录表（UUID key → 原始文件名映射）
CREATE TABLE IF NOT EXISTS uploads (
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

-- 火山Key组表
CREATE TABLE IF NOT EXISTS volc_key_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ark_model_key TEXT NOT NULL,
  ark_asset_key TEXT NOT NULL DEFAULT '',
  volc_access_key TEXT NOT NULL DEFAULT '',
  volc_secret_key TEXT NOT NULL DEFAULT '',
  is_active INTEGER DEFAULT 0,
  grouping_weight INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 图片生成历史记录表
CREATE TABLE IF NOT EXISTS image_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  size_label TEXT NOT NULL DEFAULT '',
  ref_urls TEXT NOT NULL DEFAULT '[]',
  result_urls TEXT NOT NULL DEFAULT '[]',
  credits_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'done',
  download_status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  downloaded_at DATETIME,
  deleted_at DATETIME, -- 软删时间戳；NULL = 未删除
  downloadable INTEGER DEFAULT 1, -- [已废弃] 改用 deleted_at IS NULL 统一判断可见性
  error_message TEXT,
  wuyin_task_id TEXT           -- 吴音上游任务 ID，重启后恢复轮询
);
CREATE INDEX IF NOT EXISTS idx_image_records_user ON image_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_records_project ON image_records(project_id, created_at DESC);

-- 文本生成对话表（DeepSeek）
CREATE TABLE IF NOT EXISTS tasks_texts_dialogue (
  id                  TEXT PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id          INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  name                TEXT NOT NULL DEFAULT '新对话',
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dialogue_user ON tasks_texts_dialogue(user_id, created_at DESC);

-- 文本生成消息表（DeepSeek）
CREATE TABLE IF NOT EXISTS tasks_text (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  id_of_dialogue      TEXT NOT NULL REFERENCES tasks_texts_dialogue(id) ON DELETE CASCADE,
  model               TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
  messages_in_once    TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','error')),
  tokens_prompt       INTEGER DEFAULT 0,
  tokens_completion   INTEGER DEFAULT 0,
  total_tokens        INTEGER DEFAULT 0,
  error_message       TEXT,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_text_dialogue ON tasks_text(id_of_dialogue, created_at ASC);

INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('deepseek_api_key', '', 'DeepSeek Chat API Key');

INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('deepseek_model', 'deepseek-v4-flash', 'DeepSeek 默认模型（deepseek-v4-flash / deepseek-v4-pro）');

INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('deepseek_reasoning_effort', 'high', 'DeepSeek 推理深度（low/medium/high/max）');