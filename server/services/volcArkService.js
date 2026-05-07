/**
 * 火山方舟 Ark API 任务查询服务
 * 文档：
 *   - 列表  https://www.volcengine.com/docs/82379/1521675
 *   - 详情  https://www.volcengine.com/docs/82379/1521309
 * 鉴权：Bearer <ARK_API_KEY>
 */

const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/**
 * 列出某 API Key 名下所有视频生成任务
 */
export async function listContentGenerationTasks(apiKey, options = {}) {
  if (!apiKey) throw new Error('apiKey 必填');
  const { pageNum = 1, pageSize = 20, model, status, taskIds } = options;
  const url = new URL(`${ARK_BASE_URL}/contents/generations/tasks`);
  url.searchParams.set('page_num', String(pageNum));
  url.searchParams.set('page_size', String(pageSize));
  if (model) url.searchParams.set('model', model);
  if (status) url.searchParams.set('status', status);
  if (taskIds) url.searchParams.set('task_ids', Array.isArray(taskIds) ? taskIds.join(',') : taskIds);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(body?.error?.message || body?.message || `Ark API HTTP ${res.status}`);
  }
  return body;
}

/**
 * 查询单个任务完整字段
 */
export async function getContentGenerationTask(apiKey, taskId) {
  if (!apiKey) throw new Error('apiKey 必填');
  if (!taskId) throw new Error('taskId 必填');
  const url = `${ARK_BASE_URL}/contents/generations/tasks/${encodeURIComponent(taskId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(body?.error?.message || body?.message || `Ark API HTTP ${res.status}`);
  }
  return body;
}

export default {
  listContentGenerationTasks,
  getContentGenerationTask,
};
