// 写真 (JPEG / HEIC) の Exif 読み取り入口。 依存ライブラリは使わず、 GPS
// チェックインの判定に要る項目だけを読む (tiff.ts / jpeg.ts / heic.ts)。

import { extractHeicTiff, isHeic } from './heic.ts';
import { extractJpegTiff, isJpeg } from './jpeg.ts';
import { type ExifFields, parseTiffExif } from './tiff.ts';

export type { ExifFields } from './tiff.ts';

export type PhotoMime = 'image/jpeg' | 'image/heic';

/** 写真から Exif を読む。 Exif が無い/読めなければ空オブジェクト。 */
export function readPhotoExif(bytes: Buffer, mime: PhotoMime): ExifFields {
  const tiff = mime === 'image/jpeg' ? extractJpegTiff(bytes) : extractHeicTiff(bytes);
  return (tiff && parseTiffExif(tiff)) ?? {};
}

/** バイト列の先頭が宣言された型と一致するか (Content-Type だけを信用しない)。 */
export function matchesPhotoMagic(bytes: Buffer, mime: PhotoMime): boolean {
  return mime === 'image/jpeg' ? isJpeg(bytes) : isHeic(bytes);
}

const DATETIME_RE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

/**
 * DateTimeOriginal を epoch ms にする。 OffsetTimeOriginal があれば適用し、
 * 無ければ defaultOffset (施設のタイムゾーン) とみなす。 形式不正は null。
 */
export function exifTakenAtMs(fields: ExifFields, defaultOffset: string): number | null {
  const m = fields.dateTimeOriginal ? DATETIME_RE.exec(fields.dateTimeOriginal) : null;
  if (!m) return null;
  const offset = fields.offsetTimeOriginal && OFFSET_RE.test(fields.offsetTimeOriginal)
    ? fields.offsetTimeOriginal
    : defaultOffset;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${offset}`);
  return Number.isFinite(ms) ? ms : null;
}
