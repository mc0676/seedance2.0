import type { GenerateVideoRequest, VideoGenerationResponse, FrameReferenceFlags } from '../types';
import { getAuthHeaders } from './authService';

export async function generateVideo(
  request: GenerateVideoRequest & FrameReferenceFlags & { projectId?: number; resolution?: string; referenceMode?: string },
  onProgress?: (message: string) => void
): Promise<VideoGenerationResponse> {
  const formData = new FormData();
  formData.append('prompt', request.prompt);
  formData.append('model', request.model);
  formData.append('ratio', request.ratio);
  formData.append('duration', String(request.duration));
  if (request.resolution) {
    formData.append('resolution', request.resolution);
  }
  if (request.referenceMode) {
    formData.append('referenceMode', request.referenceMode);
  }
  if (request.projectId) {
    formData.append('projectId', String(request.projectId));
  }
  if (request.firstFrameProvided !== undefined) {
    formData.append('firstFrameProvided', String(request.firstFrameProvided));
  }
  if (request.lastFrameProvided !== undefined) {
    formData.append('lastFrameProvided', String(request.lastFrameProvided));
  }

  // 传 OSS URL（新方式）
  if (request.imageUrls && request.imageUrls.length > 0) {
    formData.append('imageUrls', JSON.stringify(request.imageUrls));
  }
  if (request.videoUrl) {
    formData.append('videoUrl', request.videoUrl);
  }
  if (request.audioUrl) {
    formData.append('audioUrl', request.audioUrl);
  }

  // 兼容旧的直接 file 上传
  for (const file of request.files) {
    formData.append('files', file);
  }

  onProgress?.('正在提交视频生成请求...');
  const submitRes = await fetch('/api/generate-video', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: formData,
  });

  const submitData = await submitRes.json();
  if (!submitRes.ok) {
    throw new Error(submitData.error || `提交失败 (HTTP ${submitRes.status})`);
  }

  const { taskId } = submitData;
  if (!taskId) {
    throw new Error('服务器未返回任务ID');
  }

  onProgress?.('已提交，等待AI生成视频...');

  const maxPollTime = 25 * 60 * 1000;
  const pollInterval = 3000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxPollTime) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const pollRes = await fetch(`/api/task/${taskId}`, { headers: getAuthHeaders() });
    const pollData = await pollRes.json();

    if (pollData.status === 'done') {
      const result = pollData.result;
      if (result?.data?.[0]?.url) {
        return result;
      }
      throw new Error('未获取到视频结果');
    }

    if (pollData.status === 'error') {
      throw new Error(pollData.error || '视频生成失败');
    }

    if (pollData.progress) {
      onProgress?.(pollData.progress);
    }
  }

  throw new Error('视频生成超时，请稍后重试');
}
