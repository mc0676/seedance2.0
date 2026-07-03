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
  onProgress?: (percent: number) => void,
  onPhase?: (phase: 'uploading' | 'processing') => void,
): Promise<OssUploadResult> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mediaType', mediaType);

    const xhr = new XMLHttpRequest();

    // 超时：视频 3 分钟，图片/音频 2 分钟
    const timeoutMs = mediaType === 'video' ? 180000 : 120000;
    xhr.timeout = timeoutMs;

    // 所有文件都显示进度（不再限制 >5MB）
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        // 进度到达 95% 后不再上报（剩余 5% 留给服务端 OSS 上传阶段）
        onProgress?.(Math.min(pct, 95));
      }
    });

    // 上传完成（数据到达服务端），切换为 processing 阶段
    xhr.upload.addEventListener('load', () => {
      onPhase?.('processing');
    });

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
    xhr.addEventListener('timeout', () => {
      reject(new Error(`上传超时（超过 ${Math.round(timeoutMs / 1000)}s），请检查网络后重试`));
    });

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
 * 客户端探测视频时长（不依赖 OSS 服务端 video/info 处理）。
 * 浏览器通过 <video preload="metadata"> 仅下载 MP4/MOV 头部元数据（几 KB），不会下载完整视频。
 * 读取完毕后立即从 DOM 移除，释放内存。
 */
export function probeVideoDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;

    const cleanup = () => {
      // 暂停加载，切断网络
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    };

    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      const dur = video.duration;
      cleanup();
      if (Number.isFinite(dur) && dur > 0) {
        resolve(dur);
      } else {
        reject(new Error('无法读取视频时长，文件可能已损坏或格式不支持'));
      }
    };

    video.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const code = video.error?.code;
      if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        reject(new Error('视频格式不支持，请上传 MP4 或 MOV'));
      } else if (code === MediaError.MEDIA_ERR_NETWORK) {
        reject(new Error('原视频已不可访问（网络错误）'));
      } else {
        reject(new Error(`视频无法加载（错误码 ${code ?? '未知'}）`));
      }
    };

    video.src = url;
  });
}
