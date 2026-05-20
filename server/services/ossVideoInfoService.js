/**
 * 阿里云 OSS 视频信息探测服务
 *
 * 利用 OSS 自带的「视频信息处理」能力（IMM / Video info），通过给对象 URL 追加
 * `?x-oss-process=video/info` 参数得到一段 JSON，包含视频时长 / 分辨率 / 编码 / 帧率 等。
 *
 * 关键点：
 *   - **不下载视频到本地**，仅一次轻量 JSON 请求（通常 < 1 KB），适合磁盘极小的服务器
 *   - OSS 桶为公开读，直接拼接原始 URL + x-oss-process 参数即可，无需 SDK 签名
 *   - 若 video/info 处理不可用（桶未开通 IMM），回退到 HEAD 请求验证可访问性
 *   - 解析 `VideoStreams[0].Duration` (秒数，字符串/数字皆有) 作为「真实视频时长」
 *
 * 失败兜底：返回 { ok: false, error: '...' }；调用方按需展示给用户。
 *
 * 文档参考：
 *   https://help.aliyun.com/zh/oss/user-guide/use-video-information
 *   https://help.aliyun.com/zh/oss/developer-reference/get-video-information
 */

const OSS_URL_PREFIX = 'https://yunyu-oss.oss-cn-shanghai.aliyuncs.com/';

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
 * 检查 OSS 文件是否可访问（HEAD 请求，轻量）。
 */
async function checkAccessible(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD' });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * 通过 OSS video/info 处理拿到视频元数据。
 * 先尝试 video/info 拿时长；若处理不可用则回退为 HEAD 检查可访问性。
 * @param {string} ossUrl - 完整 OSS URL（必须在我们桶下）
 * @returns {Promise<{
 *   ok: boolean,
 *   accessible?: boolean,
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

  const baseUrl = ossUrl.split('?')[0].split('#')[0];
  const processUrl = `${baseUrl}?x-oss-process=video/info`;

  // 1. 尝试 video/info 处理拿元数据
  let resp;
  try {
    resp = await fetch(processUrl);
  } catch (e) {
    // 网络不通：回退到 HEAD 检查原始 URL 可访问性
    console.warn(`[ossVideoInfo] video/info fetch 失败: ${e.message}，回退 HEAD 检查`);
    const accessible = await checkAccessible(baseUrl);
    if (accessible) {
      return { ok: true, accessible: true, durationSec: 0 };
    }
    return { ok: false, error: `视频文件不可访问：${e.message}` };
  }

  if (!resp.ok) {
    const status = resp.status;
    // video/info 处理不可用时 OSS 返回 403/404/400，尝试回退 HEAD 检查
    console.warn(`[ossVideoInfo] video/info 返回 HTTP ${status}，回退 HEAD 检查 ${baseUrl}`);
    const accessible = await checkAccessible(baseUrl);
    if (accessible) {
      return { ok: true, accessible: true, durationSec: 0 };
    }
    if (status === 404 || status === 403) {
      return { ok: false, error: '视频文件已不存在（可能已过期或被删除）' };
    }
    return { ok: false, error: `OSS 处理失败 HTTP ${status}` };
  }

  let body;
  try {
    body = await resp.json();
  } catch (e) {
    // OSS 返回非 JSON（如 XML 错误），回退 HEAD 检查
    console.warn(`[ossVideoInfo] video/info 返回非 JSON: ${String(e).slice(0, 100)}，回退 HEAD 检查`);
    const accessible = await checkAccessible(baseUrl);
    if (accessible) {
      return { ok: true, accessible: true, durationSec: 0 };
    }
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
    accessible: true,
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
