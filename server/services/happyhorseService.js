/**
 * HappyHorse 视频生成 API（阿里云百炼 DashScope）
 * 文档：
 *   - 文生视频  https://help.aliyun.com/zh/model-studio/happyhorse-text-to-video-api-reference
 *   - 图生视频  https://help.aliyun.com/zh/model-studio/happyhorse-image-to-video-api-reference
 *   - 参考生视频
 *   - 视频编辑
 * 鉴权：Authorization: Bearer <DASHSCOPE_API_KEY>
 * 调用：异步（X-DashScope-Async: enable）→ 轮询 GET /tasks/{task_id}
 */

const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const SUBMIT_PATH = '/services/aigc/video-generation/video-synthesis';
const QUERY_PATH = '/tasks';

async function _parse(res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const rawMsg = body?.message || body?.error?.message || body?.msg || `DashScope HTTP ${res.status}`;
    const err = new Error(rawMsg);
    err.code = body?.code;
    err.requestId = body?.request_id;
    throw err;
  }
  return body;
}

/**
 * 提交 HappyHorse 任务
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model  - happyhorse-1.0-t2v / -i2v / -r2v / -video-edit
 * @param {object} args.input  - { prompt, media? }
 * @param {object} [args.parameters] - { resolution, ratio?, duration?, watermark?, seed?, audio_setting? }
 * @returns {Promise<{ task_id: string, request_id?: string }>}
 */
export async function submitTask({ apiKey, model, input, parameters }) {
  if (!apiKey) throw new Error('HappyHorse API Key 未配置');
  if (!model) throw new Error('model 必填');
  if (!input || typeof input !== 'object') throw new Error('input 必填');

  const payload = { model, input };
  if (parameters && typeof parameters === 'object') payload.parameters = parameters;

  const res = await fetch(`${DASHSCOPE_BASE_URL}${SUBMIT_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify(payload),
  });
  const body = await _parse(res);
  const taskId = body?.output?.task_id;
  if (!taskId) {
    throw new Error(body?.message || body?.output?.message || '提交 HappyHorse 任务失败：未返回 task_id');
  }
  return { task_id: taskId, request_id: body?.request_id };
}

/**
 * 查询任务状态
 * 返回结构（规范化）：
 *   {
 *     task_id, task_status, video_url?, usage?, code?, message?, request_id?
 *   }
 *   task_status 枚举：PENDING | RUNNING | SUCCEEDED | FAILED | CANCELED | UNKNOWN
 */
export async function getTask({ apiKey, taskId }) {
  if (!apiKey) throw new Error('HappyHorse API Key 未配置');
  if (!taskId) throw new Error('taskId 必填');

  const res = await fetch(`${DASHSCOPE_BASE_URL}${QUERY_PATH}/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await _parse(res);
  const output = body?.output || {};
  return {
    task_id: output.task_id || taskId,
    task_status: String(output.task_status || 'UNKNOWN').toUpperCase(),
    video_url: output.video_url || null,
    orig_prompt: output.orig_prompt || null,
    submit_time: output.submit_time || null,
    scheduled_time: output.scheduled_time || null,
    end_time: output.end_time || null,
    usage: body?.usage || null,
    code: output.code || null,
    message: output.message || null,
    request_id: body?.request_id || null,
  };
}

export default { submitTask, getTask };
