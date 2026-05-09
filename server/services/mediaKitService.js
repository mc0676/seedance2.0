/**
 * 火山 AI MediaKit 画质增强 API
 * 文档：
 *   - 提交  https://www.volcengine.com/docs/6448/2279230
 *   - 查询  https://www.volcengine.com/docs/6448/2278532
 * 鉴权：Authorization: Bearer <MEDIAKIT_API_KEY>
 */

const MEDIAKIT_BASE_URL = 'https://mediakit.cn-beijing.volces.com/api/v1';

async function _parse(res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(body?.error?.message || body?.message || body?.msg || `MediaKit HTTP ${res.status}`);
  }
  return body;
}

/**
 * 提交画质增强任务
 * @returns 火山返回的 task_id
 */
export async function submitEnhanceVideo({ apiKey, videoUrl, scene = 'aigc', toolVersion = 'standard', resolution = '1080p' }) {
  if (!apiKey) throw new Error('MediaKit API Key 未配置');
  if (!videoUrl) throw new Error('videoUrl 必填');

  const payload = {
    video_url: videoUrl,
    scene,
    tool_version: toolVersion,
    resolution,
  };

  const res = await fetch(`${MEDIAKIT_BASE_URL}/tools/enhance-video`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await _parse(res);
  if (!body?.task_id) {
    throw new Error(body?.message || '提交画质增强任务失败：未返回 task_id');
  }
  return body.task_id;
}

/**
 * 查询任务详情
 * @returns { status, result?: { video_url, resolution, duration, fps, tool_version }, error? }
 */
export async function getEnhanceTask({ apiKey, taskId }) {
  if (!apiKey) throw new Error('MediaKit API Key 未配置');
  if (!taskId) throw new Error('taskId 必填');

  const res = await fetch(`${MEDIAKIT_BASE_URL}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  return await _parse(res);
}

export default {
  submitEnhanceVideo,
  getEnhanceTask,
};
