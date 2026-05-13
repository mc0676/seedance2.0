/**
 * 火山 AI MediaKit 画质增强 API
 * 文档：
 *   - 提交  https://www.volcengine.com/docs/6448/2279230
 *   - 查询  https://www.volcengine.com/docs/6448/2278532
 * 鉴权：Authorization: Bearer <MEDIAKIT_API_KEY>
 */

import { randomUUID } from 'crypto';

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
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.videoUrl
 * @param {string} [args.scene='common']
 * @param {string} [args.toolVersion='standard']
 * @param {string} [args.resolution] - 预设分辨率：'240p'/'360p'/'480p'/'540p'/'720p'/'1080p'/'2k'/'4k'
 * @param {number} [args.resolutionLimit] - 短边像素 [64, 2160]，等比缩放（与 resolution 互斥，不能同时传）
 * @param {number} [args.fps] - 可选，目标输出帧率 (0, 120]。未传时输出保持源帧率；
 *                              若高于源帧率会触发 AI 智能插帧（建议 ≤ 源帧率 × 4）
 * @returns 火山返回的 task_id
 */
export async function submitEnhanceVideo({ apiKey, videoUrl, scene = 'common', toolVersion = 'standard', resolution, resolutionLimit, fps }) {
  if (!apiKey) throw new Error('MediaKit API Key 未配置');
  if (!videoUrl) throw new Error('videoUrl 必填');
  if (resolution && resolutionLimit) {
    throw new Error('resolution 与 resolutionLimit 不能同时设置');
  }
  if (!resolution && !resolutionLimit) {
    throw new Error('必须设置 resolution 或 resolutionLimit');
  }

  const payload = {
    video_url: videoUrl,
    scene,
    tool_version: toolVersion,
    client_token: randomUUID(),  // 每次提交唯一 token，防止 MediaKit 静默复用旧任务
  };
  if (resolution) {
    payload.resolution = resolution;
  } else {
    payload.resolution_limit = Math.max(64, Math.min(2160, Math.round(resolutionLimit)));
  }
  if (Number.isFinite(fps) && fps > 0) {
    payload.fps = Math.min(120, Math.round(fps));
  }

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
