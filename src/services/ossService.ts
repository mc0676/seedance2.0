import { getAuthHeaders } from './authService';

export interface OssVideoInfo {
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
}

export interface OssUploadResult {
  url: string;
  key: string;
  /** 视频文件上传成功后，后端通过 OSS video/info 处理探测出的元数据；非视频或探测失败时为 null */
  videoInfo?: OssVideoInfo | null;
}

/**
 * 上传文件到阿里云 OSS（通过后端代理）
 * 大于 5MB 的文件会触发 onProgress 回调显示进度条
 */
export function uploadToOss(
  file: File,
  mediaType: 'image' | 'video' | 'audio',
  onProgress?: (percent: number) => void
): Promise<OssUploadResult> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mediaType', mediaType);

    const xhr = new XMLHttpRequest();

    if (file.size > 5 * 1024 * 1024 && onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.success) {
            resolve({ url: data.url, key: data.key, videoInfo: data.videoInfo || null });
          } else {
            reject(new Error(data.error || 'OSS 上传失败'));
          }
        } catch {
          reject(new Error('OSS 上传返回格式错误'));
        }
      } else {
        try {
          const data = JSON.parse(xhr.responseText);
          reject(new Error(data.error || `上传失败 HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`上传失败 HTTP ${xhr.status}`));
        }
      }
    });

    xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));

    const authHeaders = getAuthHeaders() as Record<string, string>;
    xhr.open('POST', '/api/upload/oss');
    Object.entries(authHeaders).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });
    xhr.send(formData);
  });
}

export function getFileMediaType(file: File): 'image' | 'video' | 'audio' {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'image';
}

// 官方 Ark API 限制（Seedance 2.0 多模态）
export const FILE_LIMITS = {
  image: {
    maxSize: 30 * 1024 * 1024,       // 30MB 单张
    maxCount: 9,                      // 多模态参考最多 9 张
    accept: 'image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif',
    label: '图片',
    sizeLabel: '30MB',
    formats: 'JPEG/PNG/WEBP/BMP/TIFF/GIF',
    note: '宽高比 (0.4, 2.5)，边长 300~6000px',
  },
  video: {
    maxSize: 50 * 1024 * 1024,       // 50MB 单个
    maxCount: 3,                      // 最多 3 个参考视频，总时长 ≤15s
    accept: 'video/mp4,video/quicktime',
    label: '视频',
    sizeLabel: '50MB',
    formats: 'MP4/MOV',
    note: '时长 2~15s，宽高比 (0.4, 2.5)，边长 300~6000px，FPS 24~60',
  },
  audio: {
    maxSize: 15 * 1024 * 1024,       // 15MB 单个
    maxCount: 3,                      // 最多 3 段，总时长 ≤15s
    accept: 'audio/wav,audio/mpeg',
    label: '音频',
    sizeLabel: '15MB',
    formats: 'WAV/MP3',
    note: '时长 2~15s，不支持纯音频或文本+音频组合',
  },
};

// 输入组合校验：不支持"纯音频"或"文本+音频"（必须有图片或视频）
export function validateMediaCombination(
  _hasText: boolean,
  imageCount: number,
  videoCount: number,
  audioCount: number
): string | null {
  if (audioCount > 0 && imageCount === 0 && videoCount === 0) {
    return '音频必须配合图片或视频使用，不支持纯音频或文本+音频输入';
  }
  return null;
}

/**
 * 重新探测一个已存在的 OSS 视频 URL 的元数据。
 * 后端走 OSS video/info 处理，**不下载视频到服务器磁盘**，仅几百字节 JSON 流量。
 * 失败抛错（OSS 过期、URL 不在我们桶下、对象不存在等）。
 */
export async function probeOssVideo(url: string): Promise<OssVideoInfo> {
  const res = await fetch('/api/oss/probe-video', {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.error || '视频信息探测失败');
  }
  return data.data as OssVideoInfo;
}
