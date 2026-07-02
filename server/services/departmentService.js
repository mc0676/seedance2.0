/**
 * 部门字典服务
 *
 * `departments` 表存所有曾出现过的部门名（首次填部门 Gate 时 INSERT OR IGNORE 写入）。
 * 它只是模糊查询下拉的数据源，与 users.department 字段没有外键约束 — users 行里实际存的
 * 是部门名字符串，删除 departments 行不会影响存量用户。
 */

import { getDatabase } from '../database/index.js';

/**
 * 按名称模糊查询部门列表（不区分大小写）。
 * @param {string} q - 过滤关键字；空字符串返回前 50 条最新
 * @param {number} limit
 */
export function listDepartments(q = '', limit = 50) {
  const db = getDatabase();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  if (!q || !q.trim()) {
    return db.prepare(
      `SELECT id, name FROM departments ORDER BY name ASC LIMIT ?`
    ).all(safeLimit);
  }
  const like = `%${q.trim().replace(/[%_\\]/g, '\\$&')}%`;
  return db.prepare(
    `SELECT id, name FROM departments
     WHERE name LIKE ? ESCAPE '\\'
     ORDER BY
       CASE WHEN name = ? THEN 0
            WHEN name LIKE ? ESCAPE '\\' THEN 1
            ELSE 2 END,
       name ASC
     LIMIT ?`
  ).all(like, q.trim(), `${q.trim()}%`, safeLimit);
}

/**
 * 确保部门存在；不存在则插入。返回该部门的最终行（含 id）。
 *
 * 实现细节：**先 SELECT 再 INSERT** —— 不用 `INSERT OR IGNORE`。
 * 因为 SQLite 的 `INTEGER PRIMARY KEY AUTOINCREMENT` 在 INSERT 时先分配 id 并把
 * sqlite_sequence.seq +1，**再**检查 UNIQUE 约束；OR IGNORE 命中冲突时 seq 不会回滚，
 * 长期下来会浪费大量 id（出现 1, 2, 11, 15, 21 这种跳号）。
 *
 * 在事务里做 select-then-insert 同样并发安全：departments.name 上有 UNIQUE 约束，
 * 极端竞态时第二个 INSERT 会抛错而非脏写。
 */
export function ensureDepartment(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('部门名不能为空');
  if (trimmed.length > 60) throw new Error('部门名过长（≤60 字符）');
  const db = getDatabase();
  const existed = db.prepare(`SELECT id, name FROM departments WHERE name = ?`).get(trimmed);
  if (existed) return existed;
  try {
    const r = db.prepare(`INSERT INTO departments (name) VALUES (?)`).run(trimmed);
    return { id: r.lastInsertRowid, name: trimmed };
  } catch (e) {
    // 罕见并发：另一连接刚插入了同名行 — 重新查一次返回即可
    const retry = db.prepare(`SELECT id, name FROM departments WHERE name = ?`).get(trimmed);
    if (retry) return retry;
    throw e;
  }
}

/** 仅当部门不存在时创建；存在则抛错（用于管理员显式新建） */
export function createDepartment(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('部门名不能为空');
  if (trimmed.length > 60) throw new Error('部门名过长（≤60 字符）');
  const db = getDatabase();
  const existed = db.prepare(`SELECT id FROM departments WHERE name = ?`).get(trimmed);
  if (existed) throw new Error('该部门已存在');
  const r = db.prepare(`INSERT INTO departments (name) VALUES (?)`).run(trimmed);
  return { id: r.lastInsertRowid, name: trimmed };
}

/** 重命名部门；目标名重复则抛错。引用此 id 的 users 行无需变更（外键 + JOIN 自动随名变） */
export function renameDepartment(id, newName) {
  const trimmed = String(newName || '').trim();
  if (!trimmed) throw new Error('部门名不能为空');
  if (trimmed.length > 60) throw new Error('部门名过长（≤60 字符）');
  const db = getDatabase();
  const target = db.prepare(`SELECT id FROM departments WHERE id = ?`).get(id);
  if (!target) throw new Error('部门不存在');
  const dup = db.prepare(`SELECT id FROM departments WHERE name = ? AND id <> ?`).get(trimmed, id);
  if (dup) throw new Error('已存在同名部门');
  db.prepare(`UPDATE departments SET name = ? WHERE id = ?`).run(trimmed, id);
  return { id, name: trimmed };
}

/**
 * 删除部门。引用此 id 的 users 行 department_id 会通过 FK ON DELETE SET NULL 自动置 NULL，
 * 这些用户下次登录会被 ProfileCompletionGate 拦下要求重新选部门。
 * 返回受影响的用户数，便于 UI 提示。
 */
export function deleteDepartment(id) {
  const db = getDatabase();
  const target = db.prepare(`SELECT id, name FROM departments WHERE id = ?`).get(id);
  if (!target) throw new Error('部门不存在');
  const affected = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE department_id = ?`).get(id).n;
  // 将该部门用户迁移到默认小组（id=0），而非置空
  db.prepare(`UPDATE users SET department_id = 0 WHERE department_id = ?`).run(id);
  db.prepare(`DELETE FROM departments WHERE id = ?`).run(id);
  return { id, name: target.name, affectedUsers: affected };
}

/** 列出所有部门，附带每个部门的用户数 */
export function listDepartmentsWithCount() {
  return getDatabase().prepare(
    `SELECT d.id, d.name, d.created_at,
            (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id) AS user_count
     FROM departments d
     ORDER BY d.name ASC`
  ).all();
}

export default {
  listDepartments,
  ensureDepartment,
  createDepartment,
  renameDepartment,
  deleteDepartment,
  listDepartmentsWithCount,
};
