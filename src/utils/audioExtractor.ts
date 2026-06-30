/**
 * 浏览器端 mp4 → mp3 转码工具
 *
 * 流程：
 *   1. fetch(videoUrl) → ArrayBuffer
 *   2. AudioContext.decodeAudioData() 解码（浏览器自动处理 mp4 容器中的 AAC/H.264 音轨）
 *   3. 单声道下混 + 重采样到 44100Hz
 *   4. lamejs Mp3Encoder 编码为 MP3 Blob
 *   5. 触发浏览器下载
 */
import { Mp3Encoder } from '@breezystack/lamejs';

const TARGET_SAMPLE_RATE = 44100;
const MP3_BITRATE_KBPS = 128;
const MP3_FRAME_SIZE = 1152;

function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** 带 isExpired 标记的错误，前端可据此走友好分支而非「转码失败」。 */
export class ExpiredVideoUrlError extends Error {
  readonly isExpired = true;
  constructor(message: string) {
    super(message);
    this.name = 'ExpiredVideoUrlError';
  }
}

function makeExpiredError(msg: string): Error { return new ExpiredVideoUrlError(msg); }

/** 嗅探 TOS（X-Tos-Date + X-Tos-Expires）/ OSS（Expires=<秒级时间戳>）签名 URL 是否已过期 */
export function isSignedUrlExpired(url: string): boolean {
  try {
    // 火山 TOS
    const tosDate = url.match(/X-Tos-Date=(\d{8}T\d{6}Z)/)?.[1];
    const tosExpires = parseInt(url.match(/X-Tos-Expires=(\d+)/)?.[1] || '0', 10);
    if (tosDate && tosExpires) {
      const signedAt = new Date(tosDate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
      const expireAt = signedAt.getTime() + tosExpires * 1000;
      if (Date.now() > expireAt) return true;
    }
    // 阿里云 OSS（Expires 是秒级 epoch 时间戳）
    const ossExpires = parseInt(new URL(url, window.location.href).searchParams.get('Expires') || '0', 10);
    if (ossExpires > 0 && Date.now() / 1000 > ossExpires) return true;
  } catch {
    /* URL 解析失败时按未过期处理，让正常 fetch 流程暴露真实错误 */
  }
  return false;
}

function resample(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcIdx - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function mixToMono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const left = buf.getChannelData(0);
  const right = buf.getChannelData(1);
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    out[i] = (left[i] + right[i]) * 0.5;
  }
  return out;
}

export interface ConvertOptions {
  onStage?: (stage: 'fetch' | 'decode' | 'encode' | 'done') => void;
  onProgress?: (percent: number) => void;
}

export async function videoUrlToMp3Blob(videoUrl: string, opts: ConvertOptions = {}): Promise<Blob> {
  opts.onStage?.('fetch');

  // 提前检查 TOS / OSS 签名 URL 是否过期 —— 命中时直接抛带 isExpired 标记的错误，
  // 调用方据此显示「源视频链接已过期」之类的友好提示，而不是误导性的「转码失败」
  if (isSignedUrlExpired(videoUrl)) {
    throw makeExpiredError('音频源视频链接已过期（火山引擎签名 URL 有效期 48 小时），请重新生成。');
  }

  // 即梦 CDN 视频 URL 不支持浏览器跨域，统一走后端 /api/video-proxy
  const proxied = /^https?:\/\//i.test(videoUrl)
    ? `/api/video-proxy?url=${encodeURIComponent(videoUrl)}`
    : videoUrl;
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 30_000); // 30s 超时
  let res: Response;
  try {
    res = await fetch(proxied, { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timeoutId);
    if ((e as Error)?.name === 'AbortError') throw new Error('下载视频超时（30s），请检查网络或重新生成');
    throw e;
  }
  clearTimeout(timeoutId);
  if (!res.ok) {
    // 403/404 大多数是 TOS/OSS 签名已过期或链接已被回收
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw makeExpiredError('音频源视频已过期或不可访问，请重新生成。');
    }
    throw new Error(`下载视频失败 HTTP ${res.status}`);
  }
  const arr = await res.arrayBuffer();

  opts.onStage?.('decode');
  const AudioCtx: typeof AudioContext = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  if (!AudioCtx) throw new Error('当前浏览器不支持 AudioContext');
  const ctx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    // 部分浏览器要求传 ArrayBuffer 副本(decodeAudioData 会接管)
    decoded = await ctx.decodeAudioData(arr.slice(0));
  } catch (e) {
    throw new Error('音轨解码失败：' + ((e as Error)?.message || '浏览器不支持该编码'));
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }

  if (!decoded || decoded.length === 0) throw new Error('视频不含音轨或解码为空');

  opts.onStage?.('encode');
  const mono = mixToMono(decoded);
  const resampled = resample(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  const int16 = floatToInt16(resampled);

  const encoder = new Mp3Encoder(1, TARGET_SAMPLE_RATE, MP3_BITRATE_KBPS);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < int16.length; i += MP3_FRAME_SIZE) {
    const frame = int16.subarray(i, Math.min(i + MP3_FRAME_SIZE, int16.length));
    const mp3Buf = encoder.encodeBuffer(frame);
    if (mp3Buf.length > 0) chunks.push(new Uint8Array(mp3Buf.buffer.slice(mp3Buf.byteOffset, mp3Buf.byteOffset + mp3Buf.byteLength)));
    if (i % (MP3_FRAME_SIZE * 50) === 0) {
      opts.onProgress?.(Math.min(99, Math.round((i / int16.length) * 100)));
    }
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail.buffer.slice(tail.byteOffset, tail.byteOffset + tail.byteLength)));

  opts.onStage?.('done');
  opts.onProgress?.(100);
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
