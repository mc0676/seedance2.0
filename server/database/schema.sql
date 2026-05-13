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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
  default_max_interval INTEGER DEFAULT 50000
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
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
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
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  downloaded_at DATETIME,
  deleted_at DATETIME, -- 软删时间戳；NULL = 未删除
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
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  downloaded_at DATETIME,
  deleted_at DATETIME, -- 软删时间戳；NULL = 未删除
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 火山Key组表
CREATE TABLE IF NOT EXISTS volc_key_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ark_model_key TEXT NOT NULL,
  ark_asset_key TEXT NOT NULL DEFAULT '',
  volc_access_key TEXT NOT NULL DEFAULT '',
  volc_secret_key TEXT NOT NULL DEFAULT '',
  is_active INTEGER DEFAULT 0,
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  downloaded_at DATETIME,
  deleted_at DATETIME, -- 软删时间戳；NULL = 未删除
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_image_records_user ON image_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_records_project ON image_records(project_id, created_at DESC);
