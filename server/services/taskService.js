import { getDatabase, transaction } from '../database/index.js';

/**
 * 任务服务层
 * 扁平任务模型：每条任务对应一次生成，属于一个项目和一个用户
 */

const TASK_COLUMNS = [
  'project_id',
  'user_id',
  'prompt',
  'model',
  'ratio',
  'duration',
  'resolution',
  'status',
  'submit_id',
  'history_id',
  'item_id',
  'video_url',
  'video_path',
  'download_status',
  'download_path',
  'downloaded_at',
  'submitted_at',
  'account_info',
  'progress',
  'started_at',
  'completed_at',
  'error_message',
  'retry_count',
  'task_kind',
];

const TASK_UPDATE_FIELDS = new Set(TASK_COLUMNS);

function pickFirstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeTaskData(data = {}) {
  const projectId = pickFirstDefined(data.projectId, data.project_id);
  const userId = pickFirstDefined(data.userId, data.user_id);

  if (projectId === undefined || projectId === null) {
    throw new Error('projectId is required');
  }

  return {
    project_id: Number(projectId),
    user_id: userId ? Number(userId) : null,
    prompt: pickFirstDefined(data.prompt, ''),
    model: pickFirstDefined(data.model, null),
    ratio: pickFirstDefined(data.ratio, null),
    duration: pickFirstDefined(data.duration, null) !== null ? String(data.duration ?? data.duration) : null,
    resolution: pickFirstDefined(data.resolution, null),
    status: pickFirstDefined(data.status, 'pending'),
    submit_id: pickFirstDefined(data.submitId, data.submit_id, null),
    history_id: pickFirstDefined(data.historyId, data.history_id, null),
    item_id: pickFirstDefined(data.itemId, data.item_id, null),
    video_url: pickFirstDefined(data.videoUrl, data.video_url, null),
    video_path: pickFirstDefined(data.videoPath, data.video_path, null),
    download_status: pickFirstDefined(data.downloadStatus, data.download_status, 'pending'),
    download_path: pickFirstDefined(data.downloadPath, data.download_path, null),
    downloaded_at: pickFirstDefined(data.downloadedAt, data.downloaded_at, null),
    submitted_at: pickFirstDefined(data.submittedAt, data.submitted_at, null),
    account_info: pickFirstDefined(data.accountInfo, data.account_info, null),
    progress: pickFirstDefined(data.progress, null),
    started_at: pickFirstDefined(data.startedAt, data.started_at, null),
    completed_at: pickFirstDefined(data.completedAt, data.completed_at, null),
    error_message: pickFirstDefined(data.errorMessage, data.error_message, null),
    retry_count: Number(pickFirstDefined(data.retryCount, data.retry_count, 0) || 0),
    task_kind: pickFirstDefined(data.taskKind, data.task_kind, 'video'),
  };
}

function normalizeUpdateFields(updates = {}) {
  const normalized = {};

  for (const [key, value] of Object.entries(updates)) {
    switch (key) {
      case 'submitId':       normalized.submit_id = value; break;
      case 'historyId':      normalized.history_id = value; break;
      case 'itemId':         normalized.item_id = value; break;
      case 'videoUrl':       normalized.video_url = value; break;
      case 'videoPath':      normalized.video_path = value; break;
      case 'downloadStatus': normalized.download_status = value; break;
      case 'downloadPath':   normalized.download_path = value; break;
      case 'downloadedAt':   normalized.downloaded_at = value; break;
      case 'submittedAt':    normalized.submitted_at = value; break;
      case 'accountInfo':    normalized.account_info = value; break;
      case 'errorMessage':   normalized.error_message = value; break;
      case 'retryCount':     normalized.retry_count = value; break;
      case 'startedAt':      normalized.started_at = value; break;
      case 'completedAt':    normalized.completed_at = value; break;
      default:               normalized[key] = value; break;
    }
  }

  return normalized;
}

function insertTaskRecord(db, taskData) {
  const record = normalizeTaskData(taskData);
  const stmt = db.prepare(`
    INSERT INTO tasks (${TASK_COLUMNS.join(', ')})
    VALUES (${TASK_COLUMNS.map(() => '?').join(', ')})
  `);
  const result = stmt.run(...TASK_COLUMNS.map((col) => record[col]));
  return getTaskById(result.lastInsertRowid);
}

function cloneTaskAssetsWithDb(db, sourceTaskId, targetTaskId) {
  const assets = db.prepare(`
    SELECT asset_type, file_path, image_uri, sort_order
    FROM task_assets
    WHERE task_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(sourceTaskId);

  if (assets.length === 0) return [];

  const insertStmt = db.prepare(`
    INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const asset of assets) {
    insertStmt.run(targetTaskId, asset.asset_type, asset.file_path, asset.image_uri || null, asset.sort_order || 0);
  }
  return db.prepare(`SELECT * FROM task_assets WHERE task_id = ? ORDER BY sort_order ASC, id ASC`).all(targetTaskId);
}

/**
 * 获取任务详情
 * 非管理员：必须是任务所在项目的成员
 */
export function getTaskById(id, userId = null, isAdmin = false) {
  const db = getDatabase();

  let query = `
    SELECT t.*, p.name as project_name, u.email as created_by_email
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.id = ?
  `;
  const params = [id];

  if (!isAdmin && userId !== null) {
    query += `
      AND (
        t.user_id = ?
        OR EXISTS (
          SELECT 1 FROM project_members pm
          WHERE pm.project_id = t.project_id AND pm.user_id = ?
        )
      )
    `;
    params.push(userId, userId);
  }

  return db.prepare(query).get(...params);
}

/**
 * 创建任务
 */
export function createTask(taskData) {
  const db = getDatabase();
  return insertTaskRecord(db, taskData);
}

/**
 * 批量创建任务
 */
export function createTasksBulk(tasksData) {
  return transaction(() => {
    const db = getDatabase();
    return tasksData.map((task) => insertTaskRecord(db, task));
  });
}

/**
 * 更新任务
 */
export function updateTask(id, updates) {
  const db = getDatabase();
  const normalizedUpdates = normalizeUpdateFields(updates);
  const updatesList = [];
  const values = [];

  for (const [key, value] of Object.entries(normalizedUpdates)) {
    if (TASK_UPDATE_FIELDS.has(key)) {
      updatesList.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (updatesList.length === 0) return getTaskById(id);

  updatesList.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  db.prepare(`UPDATE tasks SET ${updatesList.join(', ')} WHERE id = ?`).run(...values);
  return getTaskById(id);
}

/**
 * 更新任务状态
 */
export function updateTaskStatus(id, status, extraUpdates = {}) {
  const updates = { status, ...extraUpdates };

  if (status === 'generating' && !extraUpdates.started_at && !extraUpdates.startedAt) {
    updates.started_at = new Date().toISOString();
  }

  if (['done', 'error', 'cancelled'].includes(status) && !extraUpdates.completed_at && !extraUpdates.completedAt) {
    updates.completed_at = new Date().toISOString();
  }

  return updateTask(id, updates);
}

/**
 * 删除任务（软删）
 * 仅设置 deleted_at 时间戳，业务行保留以供 credit_locks / usage_logs 审计追溯。
 * 所有面向用户的列表查询必须 WHERE deleted_at IS NULL。
 */
export function deleteTask(id) {
  const db = getDatabase();
  return db.prepare(`UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL`).run(id);
}

/**
 * 添加任务素材
 */
export function addTaskAsset(taskId, { assetType, filePath, imageUri, sortOrder = 0 }) {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, assetType, filePath, imageUri || null, sortOrder);
  return db.prepare(`SELECT * FROM task_assets WHERE id = ?`).get(result.lastInsertRowid);
}

/**
 * 获取任务素材列表
 */
export function getTaskAssets(taskId) {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM task_assets
    WHERE task_id = ?
    ORDER BY sort_order ASC, id ASC
  `).all(taskId);
}

/**
 * 克隆任务素材
 */
export function cloneTaskAssets(sourceTaskId, targetTaskId) {
  return transaction(() => {
    const db = getDatabase();
    return cloneTaskAssetsWithDb(db, sourceTaskId, targetTaskId);
  });
}

/**
 * 删除任务素材
 */
export function deleteTaskAsset(assetId) {
  const db = getDatabase();
  return db.prepare(`DELETE FROM task_assets WHERE id = ?`).run(assetId);
}

/**
 * 更新素材的 image_uri
 */
export function updateAssetImageUri(assetId, imageUri) {
  const db = getDatabase();
  return db.prepare(`
    UPDATE task_assets SET image_uri = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(imageUri, assetId);
}

/**
 * 获取项目下的所有任务（带素材）
 */
export function getTasksWithAssets(projectId, options = {}) {
  const tasks = getTasksByProjectId(projectId, options);
  const db = getDatabase();
  const assetsStmt = db.prepare(`SELECT * FROM task_assets WHERE task_id = ? ORDER BY sort_order ASC, id ASC`);
  return tasks.map(task => ({ ...task, assets: assetsStmt.all(task.id) }));
}

/**
 * 根据项目 ID 获取任务列表（所有成员可见）
 * 默认过滤已软删的任务（deleted_at IS NULL）
 */
export function getTasksByProjectId(projectId, options = {}) {
  const db = getDatabase();
  const whereClauses = ['t.project_id = ?', 't.deleted_at IS NULL'];
  const values = [projectId];

  if (options.status) {
    whereClauses.push('t.status = ?');
    values.push(options.status);
  }

  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  return db.prepare(`
    SELECT t.*, u.email as created_by_email
    FROM tasks t
    LEFT JOIN users u ON t.user_id = u.id
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset);
}

/**
 * 获取所有待处理的任务
 */
export function getPendingTasks() {
  const db = getDatabase();
  return db.prepare(`
    SELECT t.*, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.status = 'pending' AND t.deleted_at IS NULL
    ORDER BY t.created_at ASC
  `).all();
}

/**
 * 根据状态筛选任务
 */
export function getTasksByStatus(projectId, status) {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM tasks WHERE project_id = ? AND status = ? AND deleted_at IS NULL ORDER BY created_at DESC
  `).all(projectId, status);
}

export default {
  getTaskById,
  createTask,
  createTasksBulk,
  updateTask,
  updateTaskStatus,
  deleteTask,
  addTaskAsset,
  getTaskAssets,
  cloneTaskAssets,
  deleteTaskAsset,
  updateAssetImageUri,
  getTasksWithAssets,
  getTasksByProjectId,
  getPendingTasks,
  getTasksByStatus,
};
