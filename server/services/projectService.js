import { getDatabase } from '../database/index.js';

/**
 * 项目服务层（以项目为中心）
 * 项目 = 工作组，用户通过 project_members 加入项目
 */

/**
 * 获取用户所在的所有项目（通过 project_members 关联）
 */
export function getAllProjects(userId = null, isAdmin = false) {
  const db = getDatabase();

  let query = `
    SELECT
      p.*,
      pm.role as my_role,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status = 'done') as completed_count,
      (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) as member_count
    FROM projects p
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
  `;

  const params = [userId ?? 0];

  if (!isAdmin && userId !== null) {
    query += ` WHERE pm.user_id = ?`;
    params.push(userId);
  }

  query += ` ORDER BY p.updated_at DESC`;

  return db.prepare(query).all(...params);
}

/**
 * 根据 ID 获取项目
 * 非管理员：必须是该项目成员
 */
export function getProjectById(id, userId = null, isAdmin = false) {
  const db = getDatabase();

  let query = `
    SELECT
      p.*,
      pm.role as my_role,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status = 'done') as completed_count,
      (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) as member_count
    FROM projects p
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
    WHERE p.id = ?
  `;

  const params = [userId ?? 0, id];

  if (!isAdmin && userId !== null) {
    query += ` AND pm.user_id IS NOT NULL`;
  }

  return db.prepare(query).get(...params);
}

/**
 * 创建项目
 * 创建者自动成为 owner，同时写入 project_members
 */
export function createProject({ name, description, settings = {}, user_id }) {
  const db = getDatabase();

  if (!user_id) {
    throw new Error('创建项目时必须指定 user_id');
  }

  const result = db.prepare(`
    INSERT INTO projects (name, description, settings_json, user_id)
    VALUES (?, ?, ?, ?)
  `).run(name, description, JSON.stringify(settings), user_id);

  const projectId = result.lastInsertRowid;

  // 自动将创建者加入 project_members 为 owner
  db.prepare(`
    INSERT OR IGNORE INTO project_members (project_id, user_id, role)
    VALUES (?, ?, 'owner')
  `).run(projectId, user_id);

  return getProjectById(projectId, user_id, false);
}

/**
 * 更新项目
 */
export function updateProject(id, { name, description, settings }) {
  const db = getDatabase();

  const updates = [];
  const values = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (settings !== undefined) { updates.push('settings_json = ?'); values.push(JSON.stringify(settings)); }

  if (updates.length === 0) return getProjectById(id);

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getProjectById(id);
}

/**
 * 删除项目
 */
export function deleteProject(id) {
  const db = getDatabase();
  return db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

/**
 * 获取项目下的任务列表（所有成员可见）
 * 非管理员：必须是该项目成员
 */
export function getTasksByProjectId(projectId, options = {}, userId = null, isAdmin = false) {
  const db = getDatabase();
  const { status, limit = 100, offset = 0 } = options;

  if (!isAdmin && userId !== null) {
    const membership = db.prepare(
      'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?'
    ).get(projectId, userId);
    if (!membership) throw new Error('无权访问此项目');
  }

  let query = `
    SELECT t.*, u.email as created_by_email
    FROM tasks t
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.project_id = ?
  `;
  const params = [projectId];

  if (status) { query += ` AND t.status = ?`; params.push(status); }

  query += ` ORDER BY t.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

/**
 * 检查用户是否为项目成员
 */
export function isProjectMember(projectId, userId) {
  const db = getDatabase();
  return !!db.prepare(
    'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?'
  ).get(projectId, userId);
}

export default {
  getAllProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
  getTasksByProjectId,
  isProjectMember,
};
