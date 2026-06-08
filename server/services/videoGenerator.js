import { getDatabase } from '../database/index.js';
import * as taskService from './taskService.js';
import fs from 'fs';
import path from 'path';

// ARK 英文错误 → 中文提示映射
const ARK_ERROR_MAP = [
  { pattern: /output video may contain sensitive/i,  zh: '视频内容触发平台安全审核，请修改提示词后重试' },
  { pattern: /output video may be related to copyright/i, zh: '视频内容可能涉及版权限制，请修改提示词后重试' },
  { pattern: /input text may contain sens/i,          zh: '提示词触发安全审核，请检查文字内容后重试' },
  { pattern: /input image may contain real person/i,  zh: '图片包含真人，请更换素材后重试' },
  { pattern: /input.*sensitive/i,                     zh: '输入内容触发安全审核，请修改后重试' },
  { pattern: /output.*sensitive/i,                    zh: '生成内容触发安全审核，请修改提示词后重试' },
  { pattern: /copyright/i,                            zh: '内容涉及版权限制，请修改提示词后重试' },
  { pattern: /rate limit/i,                           zh: '请求过于频繁，请稍后重试' },
  { pattern: /insufficient.*balance/i,                zh: '火山服务端临时异常，请稍后重试' },
  { pattern: /AccountOverdueError|account.*overdue/i, zh: '火山服务端临时异常，请稍后重试' },
  { pattern: /InternalServiceError|internal.*error|unexpected internal/i, zh: '火山服务端临时异常，请稍后重试' },
  { pattern: /timeout/i,                              zh: '生成超时，请稍后重试' },
  { pattern: /has not activated the Asset Service/i,  zh: '您的帐户尚未激活资产服务，请联系管理员激活' },
];

function translateArkError(msg) {
  if (!msg) return msg;
  // 资产未找到：content[N] 中引用的 asset://xxx 在火山平台已失效
  const assetNotFoundMatch = msg.match(/content\[(\d+)\].*?asset-([\w-]+)\s+is not found/i);
  if (assetNotFoundMatch) {
    const idx = parseInt(assetNotFoundMatch[1], 10) + 1;
    const assetId = assetNotFoundMatch[2];
    return `第 ${idx} 个指定的资源 asset-${assetId} 没有找到，请重新上传资源后重试`;
  }
  // AI 辅助编程：请求过大（prompt+素材总大小超出 API 限制），后续可扩展
  // 其他已知英文错误
  for (const { pattern, zh } of ARK_ERROR_MAP) {
    if (pattern.test(msg)) return zh;
  }
  return msg;
}

const ARK_BASE_URL = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

const MODEL_MAP = {
  'seedance-2.0': 'doubao-seedance-2-0-260128',
  'seedance-2.0-fast': 'doubao-seedance-2-0-fast-260128',
};

const BENEFIT_TYPE_MAP = {
  'seedance-2.0': 'seedance_2_0',
  'seedance-2.0-fast': 'seedance_2_0_fast',
};

const VIDEO_RESOLUTION = {
  '21:9': { width: 1280, height: 548 },
  '16:9': { width: 1280, height: 720 },
  '4:3': { width: 960, height: 720 },
  '1:1': { width: 720, height: 720 },
  '3:4': { width: 720, height: 960 },
  '9:16': { width: 720, height: 1280 },
};

function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
}

async function createArkTask(apiKey, model, content, options = {}) {
  const body = { model, content, ...options };
  console.log('[video] 发送请求体:', JSON.stringify(body, null, 2).slice(0, 2000));
  const resp = await fetch(`${ARK_BASE_URL}/contents/generations/tasks`, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ark API 创建任务失败 HTTP ${resp.status}: ${translateArkError(text)}`);
  }
  return await resp.json();
}

async function getArkTask(apiKey, taskId) {
  const resp = await fetch(`${ARK_BASE_URL}/contents/generations/tasks/${taskId}`, {
    method: 'GET',
    headers: buildHeaders(apiKey),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ark API 查询任务失败 HTTP ${resp.status}: ${translateArkError(text)}`);
  }
  return await resp.json();
}

function fileToDataUri(buffer, mimeType) {
  const base64 = buffer.toString('base64');
  return `data:${mimeType || 'image/png'};base64,${base64}`;
}

async function generateSeedanceVideo(options) {
  const {
    prompt,
    ratio = '4:3',
    duration = 4,
    resolution = '720p',
    files = [],
    imageUrls = [],
    videoUrl = null,
    audioUrl = null,
    sessionId,
    model = 'seedance-2.0',
    referenceMode = 'reference',
    firstFrameProvided = false,
    lastFrameProvided = false,
    onProgress,
    onSubmitId,
    onHistoryId,
    onItemId,
    onVideoReady,
  } = options;

  const apiKey = sessionId;
  if (!apiKey) {
    throw new Error('未配置 ARK API Key，请在设置页面添加');
  }

  const modelKey = model && MODEL_MAP[model] ? model : 'seedance-2.0';
  const arkModel = MODEL_MAP[modelKey];
  const actualDuration = duration || 4;

  // 决定每张图的 role —— 按 referenceMode 路由
  // 总图片数 = files + imageUrls
  const totalImages = (files?.length || 0) + (imageUrls?.length || 0);
  const wantsFrameMode = referenceMode === 'first_last_frame';
  const hasFirstFrame = Boolean(firstFrameProvided);
  const hasLastFrame = Boolean(lastFrameProvided);

  let resolvedMode = 'reference';
  if (wantsFrameMode) {
    if (hasFirstFrame && hasLastFrame && totalImages >= 2) {
      resolvedMode = 'first_last_frame';
    } else if (hasFirstFrame && totalImages >= 1) {
      resolvedMode = 'first_frame';
    } else if (hasLastFrame && totalImages >= 1) {
      resolvedMode = 'last_frame';
    }
  }

  const roleAt = (idx) => {
    if (resolvedMode === 'first_frame') return 'first_frame';
    if (resolvedMode === 'last_frame') return 'last_frame';
    if (resolvedMode === 'first_last_frame') return idx === 0 ? 'first_frame' : 'last_frame';
    return 'reference_image';
  };
  console.log(`[video] mode=${referenceMode} → resolved=${resolvedMode} totalImages=${totalImages} first=${hasFirstFrame} last=${hasLastFrame}`);

  console.log(`[video] 使用 Ark API: model=${arkModel}, ratio=${ratio}, duration=${actualDuration}s`);

  const content = [];
  if (prompt) {
    content.push({ type: 'text', text: prompt });
  }

  // 上传文件（兼容旧的 multipart 上传方式）
  let imgIdx = 0;
  for (const file of files) {
    let dataUri;
    if (file.buffer) {
      dataUri = fileToDataUri(file.buffer, file.mimetype);
    } else if (file.path) {
      const buf = fs.readFileSync(file.path);
      const ext = path.extname(file.path).toLowerCase();
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      dataUri = fileToDataUri(buf, mime);
    } else if (file.base64) {
      dataUri = file.base64.startsWith('data:') ? file.base64 : `data:image/png;base64,${file.base64}`;
    } else {
      continue;
    }
    content.push({ type: 'image_url', image_url: { url: dataUri }, role: roleAt(imgIdx++) });
  }

  // OSS 图片 URL
  for (const url of imageUrls) {
    if (url) content.push({ type: 'image_url', image_url: { url }, role: roleAt(imgIdx++) });
  }

  // OSS 视频 URL
  if (videoUrl) {
    content.push({ type: 'video_url', video_url: { url: videoUrl }, role: 'reference_video' });
  }

  // OSS 音频 URL
  if (audioUrl) {
    content.push({ type: 'audio_url', audio_url: { url: audioUrl }, role: 'reference_audio' });
  }

  // 多于1个图片时 role 必须指定（已在上面加了 role）
  // 单图时去掉 role 也可以，但统一保留更安全

  if (content.length === 0) {
    throw new Error('请提供文本提示词或图片/视频/音频素材');
  }

  if (onProgress) await onProgress('提交任务到 Ark API...');

  const taskResult = await createArkTask(apiKey, arkModel, content, {
    ratio,
    duration: actualDuration,
    resolution,
    generate_audio: true,
  });

  const arkTaskId = taskResult.id;
  if (!arkTaskId) {
    throw new Error('Ark API 未返回任务 ID: ' + JSON.stringify(taskResult));
  }

  console.log(`[video] Ark 任务已创建: ${arkTaskId}`);

  if (onSubmitId) await onSubmitId(arkTaskId);
  if (onHistoryId) await onHistoryId(arkTaskId);

  if (onProgress) await onProgress('等待视频生成...');

  const maxWaitMs = 1800000;
  const pollInterval = 10000;
  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime < maxWaitMs) {
    attempt++;
    const result = await getArkTask(apiKey, arkTaskId);
    const status = result.status;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    console.log(`[video] 轮询 #${attempt} [${elapsed}s] status=${status}`);

    if (onProgress) {
      await onProgress(`生成中... (${elapsed}秒)`);
    }

    if (status === 'succeeded') {
      const videoUrl = result.content?.video_url;
      if (!videoUrl) {
        throw new Error('任务成功但未返回视频 URL: ' + JSON.stringify(result));
      }

      console.log(`[video] 视频生成成功: ${videoUrl.substring(0, 80)}...`);

      if (onItemId) await onItemId(arkTaskId);
      if (onVideoReady) await onVideoReady(videoUrl);

      return {
        videoUrl,
        historyId: arkTaskId,
        itemId: arkTaskId,
        submitId: arkTaskId,
        revisedPrompt: prompt || '',
        usage: result.usage || null,
      };
    }

    if (status === 'failed') {
      const rawMsg = result.error?.message || result.error?.code || JSON.stringify(result.error || result);
      throw new Error(`视频生成失败: ${translateArkError(rawMsg)}`);
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error('视频生成超时（30分钟）');
}

function updateTaskStatus(taskId, status, videoUrl = null, historyId = null) {
  const extra = {};
  if (videoUrl) extra.video_url = videoUrl;
  if (historyId) extra.history_id = historyId;
  taskService.updateTaskStatus(taskId, status, extra);
}

export {
  generateSeedanceVideo,
  getArkTask,
  updateTaskStatus,
  MODEL_MAP,
  BENEFIT_TYPE_MAP,
  VIDEO_RESOLUTION,
};