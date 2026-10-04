// JPEG の APP1 ("Exif\0\0") セグメントから TIFF 部分を取り出す。

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');

export function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** APP1 Exif の TIFF バイト列。 見つからなければ null。 */
export function extractJpegTiff(buf: Buffer): Buffer | null {
  if (!isJpeg(buf)) return null;
  let at = 2;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return null;
    const marker = buf[at + 1] as number;
    // fill byte (0xFF の連続) は読み飛ばす。
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // SOS / EOI 以降にメタデータは無い。
    if (marker === 0xda || marker === 0xd9) return null;
    const len = buf.readUInt16BE(at + 2);
    if (len < 2 || at + 2 + len > buf.length) return null;
    const start = at + 4;
    if (marker === 0xe1 && buf.subarray(start, start + EXIF_HEADER.length).equals(EXIF_HEADER)) {
      return buf.subarray(start + EXIF_HEADER.length, at + 2 + len);
    }
    at += 2 + len;
  }
  return null;
}
