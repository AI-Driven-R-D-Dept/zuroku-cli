import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import type { UploadPayload } from '@zuroku/core';

// thumbnail / OG 画像規約: `thumb.{png|jpg|jpeg|webp|gif}` という basename の asset を
// サーバ (worker-app) が thumbnail_key に自動採用し、worker-content が OG 画像として配信する。
const THUMB_RE = /^thumb\.(png|jpe?g|webp|gif)$/i;

const JPEG_QUALITY = 82;
const DEFAULT_MAX_LONG_EDGE = 2000;

/** basename が thumbnail 規約 (`thumb.*`) かどうか。 */
export function isThumbName(basename: string): boolean {
  return THUMB_RE.test(basename);
}

/** thumb の拡張子が GIF か (アニメ保持のため JPEG 変換対象外)。 */
export function isGifThumb(basename: string): boolean {
  return /\.gif$/i.test(basename);
}

/**
 * thumbnail を **JPEG** に変換して返す (`thumb.jpg` / `image/jpeg`)。
 *
 * 通常 asset は WebP 圧縮 (compressForUpload) するが、OG 画像 (SNS unfurl 用) を WebP で
 * 配信すると LinkedIn / Facebook / LINE 等の unfurler がカード画像を描画しない既知の問題が
 * ある (Slack / Discord は WebP OK)。OG に使われる thumb だけは互換性の高い JPEG に揃える。
 *
 * resize 方針は core の compressForUpload と対称 (長辺 <= maxLongEdge、EXIF orientation 反映)。
 * GIF は呼び出し側で除外する前提 (アニメを失うため)。
 */
export async function compressThumbToJpeg(
  srcPath: string,
  opts: { maxLongEdge?: number } = {},
): Promise<UploadPayload> {
  const maxLongEdge = opts.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
  const input = await fs.readFile(srcPath);
  const pipeline = sharp(input, { failOn: 'none' }).rotate(); // honor EXIF orientation

  const meta = await pipeline.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const longEdge = Math.max(w, h);
  if (longEdge > maxLongEdge && longEdge > 0) {
    if (w >= h) {
      pipeline.resize({ width: maxLongEdge, withoutEnlargement: true });
    } else {
      pipeline.resize({ height: maxLongEdge, withoutEnlargement: true });
    }
  }

  // srcPath の拡張子 (thumb.png / thumb.webp 等) に依らず出力は thumb.jpg に統一する。
  const buffer = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
  return { buffer, contentType: 'image/jpeg', filename: 'thumb.jpg' };
}
