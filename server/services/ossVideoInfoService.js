/**
 * 阿里云 OSS 视频信息探测服务
 *
 * 利用 OSS 自带的「视频信息处理」能力（IMM / Video info），通过给对象 URL 追加
 * `?x-oss-process=video/info` 参数得到一段 JSON，包含视频时长 / 分辨率 / 编码 / 帧率 等。
 *
 * 关键点：
 *   - **不下载视频到本地**，仅一次轻量 JSON 请求（通常 < 1 KB），适合磁盘极小的服务器
 *   - 用 `client.signatureUrl` 生成临时签名 URL（即使对象是 private 也能拿到 JSON）
 *   - 解析 `VideoStreams[0].Duration` (秒数，字符串/数字皆有) 作为「真实视频时长」
 *
 * 失败兜底：返回 { ok: false, error: '...' }；调用方按需展示给用户。
 *
 * 文档参考：
 *   https://help.aliyun.com/zh/oss/user-guide/use-video-information
 *   https://help.aliyun.com/zh/oss/developer-reference/get-video-information
 */

import OSS from 'ali-oss';

// 与 server/index.js 同源的 OSS 配置（保持一致；如未来抽公共配置，统一从那里 import）
const OSS_CONFIG = {
  region: 'oss-cn-shanghai',
  accessKeyId: 'LTAI5tL9SYY5FN5eSJ3Yhxw9',
  accessKeySecret: 'atR8ItYSJhCIA76C2imtUKNr3h24Zr',
  bucket: 'yunyu-oss',
};
const OSS_URL_PREFIX = 'https://yunyu-oss.oss-cn-shanghai.aliyuncs.com/';

function createClient() {
  return new OSS({ ...OSS_CONFIG, timeout: 30000 });
}

/**
 * 从 OSS URL 中提取对象 key（去掉桶域名前缀和可能的 query / fragment）。
 * 仅支持本系统使用的 `yunyu-oss.oss-cn-shanghai.aliyuncs.com` 域名；其他域名返回 null。
 */
export function extractOssKey(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith(OSS_URL_PREFIX)) return null;
  const rest = url.slice(OSS_URL_PREFIX.length);
  return rest.split('?')[0].split('#')[0] || null;
}

/**
 * 通过 OSS video/info 处理拿到视频元数据。
 * @param {string} ossUrl - 完整 OSS URL（必须在我们桶下）
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   durationSec?: number,
 *   width?: number,
 *   height?: number,
 *   fps?: number,
 *   bitrate?: number,
 *   format?: string,
 *   raw?: any,
 * }>}
 */
export async function probeVideoInfo(ossUrl) {
  const key = extractOssKey(ossUrl);
  if (!key) {
    return { ok: false, error: '不是受支持的 OSS URL（仅支持本平台 yunyu-oss）' };
  }
  const client = createClient();

  // 用 signatureUrl 拿到带签名的处理 URL。即使桶是 private 也能用；公有读时签名也无害。
  // 过期 60s 足以完成一次 fetch；很短的 TTL 避免日志暴露 URL 后被盗用。
  let signedUrl;
  try {
    signedUrl = client.signatureUrl(key, { expires: 60, process: 'video/info' });
  } catch (e) {
    return { ok: false, error: `OSS 签名失败：${e.message}` };
  }

  let resp;
  try {
    resp = await fetch(signedUrl);
  } catch (e) {
    return { ok: false, error: `网络请求失败：${e.message}` };
  }

  if (!resp.ok) {
    // 对象不存在或被删 → OSS 通常返回 404；签名过期返回 403
    if (resp.status === 404) {
      return { ok: false, error: '视频文件已不存在（可能已过期或被删除）' };
    }
    if (resp.status === 403) {
      return { ok: false, error: '视频访问被拒（OSS 凭证或权限异常）' };
    }
    return { ok: false, error: `OSS 处理失败 HTTP ${resp.status}` };
  }

  let body;
  try {
    body = await resp.json();
  } catch (e) {
    // OSS 在非视频文件上调 video/info 会返回 XML 错误
    return { ok: false, error: '该文件不是视频或无法解析' };
  }

  // body 结构：
  // {
  //   "VideoStreams": [{ "Duration": "4.000", "Width": 1920, "Height": 1080, "FPS": "24.000", "Bitrate": "...", "CodecName": "h264" }],
  //   "AudioStreams": [...],
  //   "Format": { "Duration": "4.000", "FormatName": "mov,mp4...", "Bitrate": "..." }
  // }
  const vs = Array.isArray(body?.VideoStreams) ? body.VideoStreams[0] : null;
  const fmt = body?.Format || null;
  const rawDur = vs?.Duration ?? fmt?.Duration;
  const durationSec = Number(rawDur);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, error: '视频元数据缺失时长字段', raw: body };
  }

  return {
    ok: true,
    durationSec,
    width: Number(vs?.Width) || undefined,
    height: Number(vs?.Height) || undefined,
    fps: Number(vs?.FPS) || undefined,
    bitrate: Number(vs?.Bitrate ?? fmt?.Bitrate) || undefined,
    format: fmt?.FormatName || undefined,
    raw: body,
  };
}

export default { extractOssKey, probeVideoInfo };
