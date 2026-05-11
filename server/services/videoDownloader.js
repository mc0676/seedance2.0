import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database/index.js';

/**
 * 将 image_records 行转换为 DownloadTask 格式
 */
function imageRecordToTask(r) {
  let resultUrls = [];
  try { resultUrls = JSON.parse(r.result_urls || '[]'); } catch {}
  return {
    id: r.id,
    prompt: r.prompt,
    model: r.model,
    ratio: r.size_label,
    duration: null,
    resolution: null,
    status: 'done',
    download_status: 'pending',
    video_url: null,
    image_urls: resultUrls,
    video_path: null,
    download_path: null,
    downloaded_at: null,
    account_info: null,
    submit_id: null,
    history_id: null,
    created_at: r.created_at,
    completed_at: r.created_at,
    error_message: null,
    project_id: r.project_id,
    project_name: null,
    hasHistory: false,
    model_type: 'image',
    effective_download_status: 'pending',
    assets: [],
    credits_used: r.credits_used,
  };
}

/**
 * 将 audio_generations 行（已 JOIN tasks/projects）转为 DownloadTask 格式
 * 前端按 model_type='audio' 走浏览器端 mp4→mp3 转码下载
 */
function audioGenerationToTask(r) {
  const videoUrl = r.intermediate_video_url || r.task_video_url || null;
  let effective = 'generating';
  if (r.status === 'done' && videoUrl) effective = 'pending';
  else if (r.status === 'error') effective = 'failed';
  return {
    id: r.id,
    prompt: r.voice_prompt,
    model: 'audio',
    ratio: null,
    duration: null,
    resolution: null,
    status: r.status === 'done' ? 'done' : (r.status === 'error' ? 'error' : 'generating'),
    download_status: 'pending',
    video_url: videoUrl,
    reference_image_url: r.reference_image_url,
    video_path: null,
    download_path: null,
    downloaded_at: null,
    account_info: null,
    submit_id: null,
    history_id: null,
    created_at: r.created_at,
    completed_at: r.finished_at,
    error_message: r.error_message,
    project_id: r.project_id,
    project_name: r.project_name || null,
    hasHistory: false,
    model_type: 'audio',
    effective_download_status: effective,
    assets: [],
    credits_used: r.credits_used,
  };
}

/**
 * 查询 audio_generations 列表（带 task/project JOIN）
 * status 过滤复用下载管理的语义：
 *   generating → audio_generations.status IN ('pending','generating')
 *   pending    → status='done' 且有视频 URL
 *   done       → 仅服务器侧已完成转码时使用，本表不存储 mp3，直接归并到 pending
 *   failed     → status='error'
 */
function queryAudioRows({ db, projectId, isAdmin, userId, status }) {
  const where = [];
  const params = [];
  if (projectId) { where.push('a.project_id = ?'); params.push(projectId); }
  // 工作组共享：与视频任务一致——同 project_members 互相可见
  if (!isAdmin && userId !== null) {
    where.push(`(a.user_id = ? OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = a.project_id AND pm.user_id = ?
    ))`);
    params.push(userId, userId);
  }
  if (status === 'generating') {
    where.push("a.status IN ('pending','generating')");
  } else if (status === 'pending') {
    where.push("a.status = 'done' AND COALESCE(a.intermediate_video_url, t.video_url) IS NOT NULL");
  } else if (status === 'failed') {
    where.push("a.status = 'error'");
  } else if (status === 'done' || status === 'downloading') {
    where.push('1 = 0'); // 音频无服务端"已下载/下载中"状态
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT a.id, a.task_id, a.project_id, a.reference_image_url, a.voice_prompt,
           a.status, a.intermediate_video_url, a.credits_used, a.error_message,
           a.created_at, a.finished_at,
           t.video_url AS task_video_url,
           p.name AS project_name
    FROM audio_generations a
    LEFT JOIN tasks t ON t.id = a.task_id
    LEFT JOIN projects p ON p.id = a.project_id
    ${whereClause}
    ORDER BY a.created_at DESC
  `).all(...params);
}

/**
 * 视频下载服务
 * 负责将生成的视频保存到本地
 */

/**
 * 规范化文件名
 */
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|？*]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}

/**
 * 确保目录存在
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * 下载视频到本地
 * @param {string} videoUrl - 视频 URL
 * @param {string} savePath - 保存路径（目录）
 * @param {string} filename - 文件名（不含扩展名）
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
export async function downloadVideo(videoUrl, savePath, filename) {
  try {
    // 确保保存目录存在
    const targetDir = ensureDir(savePath);

    // 生成安全的文件名
    const safeFilename = sanitizeFilename(filename);
    const filepath = path.join(targetDir, `${safeFilename}.mp4`);

    // 下载视频
    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }

    // 检查 Content-Type
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('video')) {
      console.warn('[download] 非视频内容类型:', contentType);
    }

    // 创建写入流
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(filepath, buffer);

    // 验证文件
    const stats = fs.statSync(filepath);
    if (stats.size === 0) {
      fs.unlinkSync(filepath);
      throw new Error('下载的文件为空');
    }

    console.log(`[download] 视频已保存：${filepath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);

    return {
      success: true,
      path: filepath,
      size: stats.size,
    };
  } catch (error) {
    console.error('[download] 下载失败:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

function getTaskWithProject(taskId) {
  const db = getDatabase();
  return db.prepare(`
    SELECT t.*, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.id = ?
  `).get(taskId);
}

function buildTaskVideoFilename(task, taskId) {
  const promptPreview = task.prompt ? sanitizeFilename(task.prompt.substring(0, 30)) : '';
  const baseName = `${sanitizeFilename(task.project_name || 'project')}_task${taskId}${promptPreview ? `_${promptPreview}` : ''}`;
  return `${baseName}.mp4`;
}

/**
 * 根据任务 ID 下载视频
 * @param {number} taskId - 任务 ID
 * @param {string} baseDownloadPath - 基础下载路径
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
export async function downloadVideoByTaskId(taskId, baseDownloadPath) {
  try {
    const db = getDatabase();
    const task = getTaskWithProject(taskId);

    if (!task) {
      return { success: false, error: '任务不存在' };
    }

    if (!task.video_url) {
      return { success: false, error: '任务没有视频 URL' };
    }

    // 构建保存路径：baseDownloadPath/project_name/
    const projectDir = path.join(baseDownloadPath, sanitizeFilename(task.project_name || `project_${task.project_id}`));
    const filename = buildTaskVideoFilename(task, taskId).replace(/\.mp4$/i, '');

    // 下载视频
    const result = await downloadVideo(task.video_url, projectDir, filename);

    if (result.success) {
      // 更新任务的 video_path
      db.prepare(`UPDATE tasks SET video_path = ? WHERE id = ?`).run(result.path, taskId);
    }

    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 获取已下载视频文件信息
 * @param {number} taskId - 任务 ID
 * @returns {{success: boolean, filePath?: string, filename?: string, task?: any, error?: string}}
 */
export function getDownloadedVideoFileByTaskId(taskId) {
  try {
    const task = getTaskWithProject(taskId);

    if (!task) {
      return { success: false, error: '任务不存在' };
    }

    if (!task.video_path) {
      return { success: false, error: '任务尚未下载到服务器' };
    }

    if (!fs.existsSync(task.video_path)) {
      return { success: false, error: '视频文件不存在，可能已被删除' };
    }

    return {
      success: true,
      task,
      filePath: task.video_path,
      filename: path.basename(task.video_path) || buildTaskVideoFilename(task, taskId),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 打开视频所在文件夹
 * @param {string} videoPath - 视频文件路径
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function openVideoFolder(videoPath) {
  try {
    const { exec } = await import('child_process');
    const dirPath = path.dirname(videoPath);

    // 检查目录是否存在
    if (!fs.existsSync(dirPath)) {
      throw new Error('目录不存在');
    }

    // 根据平台打开文件夹
    const platform = process.platform;

    return new Promise((resolve, reject) => {
      let command;

      if (platform === 'win32') {
        command = `explorer "${dirPath}"`;
      } else if (platform === 'darwin') {
        command = `open "${dirPath}"`;
      } else {
        // Linux (包括 WSL)
        command = `xdg-open "${dirPath}"`;
      }

      exec(command, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve({ success: true });
        }
      });
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 获取下载路径设置
 */
export function getDefaultDownloadPath() {
  const db = getDatabase();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'download_path'`).get();

  if (row && row.value) {
    return row.value;
  }

  // 默认下载到数据卷目录，确保 Docker 重建后文件持久保存
  return path.join(process.cwd(), 'server', 'data', 'downloads');
}

/**
 * 批量下载视频
 */
export async function batchDownloadVideos(taskIds, baseDownloadPath) {
  const results = [];

  for (const taskId of taskIds) {
    const result = await downloadVideoByTaskId(taskId, baseDownloadPath);
    results.push({ taskId, ...result });
  }

  return results;
}

/**
 * 获取下载任务列表
 * @param {Object} options - 查询选项
 * @param {string} options.status - 下载状态筛选
 * @param {string} options.type - 类型筛选
 * @param {number} options.page - 页码（从 1 开始）
 * @param {number} options.pageSize - 每页数量
 * @param {number|null} options.userId - 用户 ID，用于过滤（非管理员只能查看自己的任务）
 * @param {boolean} options.isAdmin - 是否管理员，true 时忽略 userId 过滤
 * @returns {Object} { tasks, total, page, pageSize }
 */
export function getDownloadTasks(options = {}) {
  const db = getDatabase();
  const {
    status = 'all',
    type = 'all',
    page = 1,
    pageSize = 20,
    userId = null,
    isAdmin = false,
    projectId = null,
  } = options;

  const whereClauses = [];
  const params = [];

  // 默认只显示 task_kind='video'，过滤掉音频生成的中间产物（audio_intermediate）
  whereClauses.push("(t.task_kind IS NULL OR t.task_kind = 'video')");

  // 项目过滤（前端按当前工作组限定）
  if (projectId) {
    whereClauses.push('t.project_id = ?');
    params.push(projectId);
  }

  // 非管理员用户只能查看自己创建的任务或所在工作组的任务
  if (!isAdmin && userId !== null) {
    whereClauses.push(`(t.user_id = ? OR EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = t.project_id AND pm.user_id = ?
    ))`);
    params.push(userId, userId);
  }

  if (status !== 'all') {
    if (status === 'generating') {
      whereClauses.push("(t.status = 'generating' OR (t.history_id IS NOT NULL AND t.video_url IS NULL AND t.status != 'cancelled'))");
    } else if (status === 'pending') {
      whereClauses.push("(t.video_url IS NOT NULL AND (t.download_status IS NULL OR t.download_status = 'pending'))");
    } else {
      whereClauses.push('t.download_status = ?');
      params.push(status);
    }
  }

  // 图片类型：直接从 image_records 返回
  if (type === 'image') {
    const imgWhere = [];
    const imgParams = [];
    if (projectId) { imgWhere.push('project_id = ?'); imgParams.push(projectId); }
    if (!isAdmin && userId !== null) {
      imgWhere.push(`(user_id = ? OR EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = image_records.project_id AND pm.user_id = ?
      ))`);
      imgParams.push(userId, userId);
    }
    const imgWhereClause = imgWhere.length ? `WHERE ${imgWhere.join(' AND ')}` : '';
    const imgTotal = db.prepare(`SELECT COUNT(*) as n FROM image_records ${imgWhereClause}`).get(...imgParams).n;
    const imgOffset = (page - 1) * pageSize;
    const imgRows = db.prepare(`SELECT * FROM image_records ${imgWhereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...imgParams, pageSize, imgOffset);
    return {
      tasks: imgRows.map((r) => imageRecordToTask(r)),
      total: imgTotal,
      page,
      pageSize,
    };
  }

  // 音频类型：直接从 audio_generations 返回
  if (type === 'audio') {
    const audioRows = queryAudioRows({ db, projectId, isAdmin, userId, status });
    const audioTasks = audioRows.map((r) => audioGenerationToTask(r));
    const audioOffset = (page - 1) * pageSize;
    return {
      tasks: audioTasks.slice(audioOffset, audioOffset + pageSize),
      total: audioTasks.length,
      page,
      pageSize,
    };
  }

  const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const countStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM tasks t
    ${whereClause}
  `);
  const { count: total } = countStmt.get(...params);

  const columnSelect = `
    SELECT
      t.id,
      t.prompt,
      t.model,
      t.ratio,
      t.duration,
      t.resolution,
      t.status,
      t.download_status,
      t.video_url,
      t.video_path,
      t.download_path,
      t.downloaded_at,
      t.account_info,
      t.history_id,
      t.item_id,
      t.submit_id,
      t.created_at,
      t.completed_at,
      t.error_message,
      t.project_id,
      p.name as project_name,
      CASE
        WHEN t.status IN ('generating', 'processing') OR (t.history_id IS NOT NULL AND t.video_url IS NULL AND t.status NOT IN ('error', 'cancelled', 'done')) THEN 'generating'
        WHEN t.status = 'done' AND t.video_url IS NOT NULL AND t.download_status = 'done' THEN 'done'
        WHEN t.status = 'done' AND t.video_url IS NOT NULL THEN 'pending'
        WHEN t.status = 'error' OR t.status = 'cancelled' THEN 'failed'
        WHEN t.download_status = 'failed' THEN 'failed'
        ELSE 'failed'
      END as effective_download_status
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    ${whereClause}
  `;

  // type=all 时需要全量拉取，不能先分页再合并
  if (type === 'all') {
    const allVideos = db.prepare(`${columnSelect} ORDER BY t.created_at DESC`).all(...params);
    const videoTasks = allVideos.map((task) => ({
      ...task,
      hasHistory: !!task.history_id,
      model_type: 'video',
      assets: [],
      enhancements: [],
    }));
    // 批量拉取素材
    const allTaskIds = allVideos.map((t) => t.id);
    if (allTaskIds.length > 0) {
      const placeholders = allTaskIds.map(() => '?').join(',');
      const assets = db.prepare(
        `SELECT task_id, asset_type, image_uri, original_name, sort_order FROM task_assets WHERE task_id IN (${placeholders}) AND image_uri IS NOT NULL AND image_uri != '' ORDER BY sort_order ASC`
      ).all(...allTaskIds);
      const assetsByTask = {};
      for (const a of assets) {
        if (!assetsByTask[a.task_id]) assetsByTask[a.task_id] = [];
        assetsByTask[a.task_id].push({ assetType: a.asset_type, uri: a.image_uri, originalName: a.original_name || null });
      }
      const enhancements = db.prepare(
        `SELECT id, task_id, status, tool_version, scene, target_resolution,
                enhanced_video_url, error_message, credits_used, duration_seconds,
                created_at, finished_at
         FROM video_enhancements WHERE task_id IN (${placeholders})
         ORDER BY created_at DESC`
      ).all(...allTaskIds);
      const enhancementsByTask = {};
      for (const e of enhancements) {
        if (!enhancementsByTask[e.task_id]) enhancementsByTask[e.task_id] = [];
        enhancementsByTask[e.task_id].push(e);
      }
      for (const t of videoTasks) {
        t.assets = assetsByTask[t.id] || [];
        t.enhancements = enhancementsByTask[t.id] || [];
      }
    }
    // 合并图片
    const imgWhere = [];
    const imgParams = [];
    if (projectId) { imgWhere.push('project_id = ?'); imgParams.push(projectId); }
    if (!isAdmin && userId !== null) {
      imgWhere.push(`(user_id = ? OR EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = image_records.project_id AND pm.user_id = ?
      ))`);
      imgParams.push(userId, userId);
    }
    const imgWhereClause = imgWhere.length ? `WHERE ${imgWhere.join(' AND ')}` : '';
    const imgRows = db.prepare(`SELECT * FROM image_records ${imgWhereClause} ORDER BY created_at DESC`).all(...imgParams);
    const imgTasks = imgRows.map((r) => imageRecordToTask(r));
    // 合并音频
    const audioRows = queryAudioRows({ db, projectId, isAdmin, userId, status });
    const audioTasks = audioRows.map((r) => audioGenerationToTask(r));
    const merged = [...videoTasks, ...imgTasks, ...audioTasks].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return {
      tasks: merged.slice((page - 1) * pageSize, page * pageSize),
      total: merged.length,
      page,
      pageSize,
    };
  }

  const offset = (page - 1) * pageSize;
  const stmt = db.prepare(`${columnSelect} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`);
  const tasks = stmt.all(...params, pageSize, offset);

  // 批量拉取素材（image_uri 有内容的才有意义）
  const taskIds = tasks.map((t) => t.id);
  let assetsByTask = {};
  let enhancementsByTask = {};
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(',');
    const assets = db.prepare(
      `SELECT task_id, asset_type, image_uri, original_name, sort_order FROM task_assets WHERE task_id IN (${placeholders}) AND image_uri IS NOT NULL AND image_uri != '' ORDER BY sort_order ASC`
    ).all(...taskIds);
    for (const a of assets) {
      if (!assetsByTask[a.task_id]) assetsByTask[a.task_id] = [];
      assetsByTask[a.task_id].push({ assetType: a.asset_type, uri: a.image_uri, originalName: a.original_name || null });
    }
    const enhancements = db.prepare(
      `SELECT id, task_id, status, tool_version, scene, target_resolution,
              enhanced_video_url, error_message, credits_used, duration_seconds,
              created_at, finished_at
       FROM video_enhancements WHERE task_id IN (${placeholders})
       ORDER BY created_at DESC`
    ).all(...taskIds);
    for (const e of enhancements) {
      if (!enhancementsByTask[e.task_id]) enhancementsByTask[e.task_id] = [];
      enhancementsByTask[e.task_id].push(e);
    }
  }

  const videoTasks = tasks.map((task) => ({
    ...task,
    hasHistory: !!task.history_id,
    model_type: 'video',
    assets: assetsByTask[task.id] || [],
    enhancements: enhancementsByTask[task.id] || [],
  }));



  return {
    tasks: videoTasks,
    total,
    page,
    pageSize,
  };
}

/**
 * 更新下载状态
 */
export function updateDownloadStatus(taskId, status, extraData = {}) {
  try {
    const db = getDatabase();
    const updates = ['download_status = ?'];
    const values = [status];

    if (status === 'done' && extraData.downloadPath) {
      updates.push('download_path = ?');
      values.push(extraData.downloadPath);
    }
    if (status === 'done') {
      updates.push('downloaded_at = CURRENT_TIMESTAMP');
    }
    if (extraData.error) {
      updates.push('error_message = ?');
      values.push(extraData.error);
    }

    values.push(taskId);

    db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export default {
  downloadVideo,
  downloadVideoByTaskId,
  getDownloadedVideoFileByTaskId,
  openVideoFolder,
  getDefaultDownloadPath,
  batchDownloadVideos,
  getDownloadTasks,
  updateDownloadStatus,
};
