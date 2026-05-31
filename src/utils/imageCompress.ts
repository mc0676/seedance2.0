/**
 * 浏览器端图片压缩工具
 * 消耗用户本地资源（Canvas），不占服务器带宽
 * 原始文件不修改，返回新的压缩Blob
 */

export interface CompressOptions {
  /** 长边最大像素，默认200（封面缩略图） */
  maxSize?: number;
  /** JPEG质量 0~1，默认0.75 */
  quality?: number;
  /** 输出格式，默认image/jpeg */
  mimeType?: string;
}

/**
 * 压缩图片文件
 * @param file 原始图片File
 * @param opts 压缩选项
 * @returns 压缩后的Blob
 */
export async function compressImage(
  file: File,
  opts: CompressOptions = {},
): Promise<Blob> {
  const { maxSize = 200, quality = 0.75, mimeType = 'image/jpeg' } = opts;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      const { naturalWidth: w, naturalHeight: h } = img;
      // 等比缩放，长边不超过maxSize
      const scale = Math.min(1, maxSize / Math.max(w, h));
      const dw = Math.round(w * scale);
      const dh = Math.round(h * scale);

      const canvas = document.createElement('canvas');
      canvas.width = dw;
      canvas.height = dh;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas context unavailable')); return; }

      ctx.drawImage(img, 0, 0, dw, dh);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Canvas toBlob failed'));
        },
        mimeType,
        quality,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image load failed'));
    };

    img.src = url;
  });
}

/**
 * 压缩图片并转为File（保留文件名，方便直接传给uploadToOss）
 */
export async function compressImageToFile(
  file: File,
  opts: CompressOptions = {},
): Promise<File> {
  const blob = await compressImage(file, opts);
  const ext = (opts.mimeType ?? 'image/jpeg') === 'image/webp' ? 'webp' : 'jpg';
  const name = file.name.replace(/\.[^.]+$/, '') + `_thumb.${ext}`;
  return new File([blob], name, { type: blob.type });
}
