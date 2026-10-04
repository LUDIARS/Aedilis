// HEIC (ISOBMFF / HEIF) の Exif item から TIFF 部分を取り出す。
//
// meta → iinf/infe で item_type "Exif" の item_ID を引き、 iloc でファイル内の
// 位置を引く。 Exif item 本体は先頭 4 byte が TIFF ヘッダまでのオフセット
// (通常 6 = "Exif\0\0")。 construction_method 0 (ファイルオフセット) だけ扱う。

interface Box {
  type: string;
  /** ヘッダ直後 (payload 先頭)。 */
  start: number;
  end: number;
}

interface Extent {
  offset: number;
  length: number;
}

function readBoxes(buf: Buffer, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    boxes.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

function readUInt(buf: Buffer, at: number, size: number): number {
  if (size === 0) return 0;
  if (size === 4) return buf.readUInt32BE(at);
  if (size === 8) return Number(buf.readBigUInt64BE(at));
  throw new RangeError(`unsupported iloc int size ${size}`);
}

export function isHeic(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp';
}

function findExifItemId(buf: Buffer, iinf: Box): number | null {
  const version = buf[iinf.start] as number;
  const entriesFrom = iinf.start + 4 + (version === 0 ? 2 : 4);
  for (const infe of readBoxes(buf, entriesFrom, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const infeVersion = buf[infe.start] as number;
    if (infeVersion < 2) continue;
    let at = infe.start + 4;
    const itemId = infeVersion === 2 ? buf.readUInt16BE(at) : buf.readUInt32BE(at);
    at += infeVersion === 2 ? 2 : 4;
    at += 2; // item_protection_index
    if (buf.toString('latin1', at, at + 4) === 'Exif') return itemId;
  }
  return null;
}

function findItemExtent(buf: Buffer, iloc: Box, itemId: number): Extent | null {
  const version = buf[iloc.start] as number;
  const hasConstruction = version === 1 || version === 2;
  let at = iloc.start + 4;
  const sizes = buf.readUInt16BE(at);
  at += 2;
  const offsetSize = (sizes >> 12) & 0xf;
  const lengthSize = (sizes >> 8) & 0xf;
  const baseOffsetSize = (sizes >> 4) & 0xf;
  const indexSize = hasConstruction ? sizes & 0xf : 0;
  const idSize = version < 2 ? 2 : 4;
  const itemCount = idSize === 2 ? buf.readUInt16BE(at) : buf.readUInt32BE(at);
  at += idSize;
  for (let i = 0; i < itemCount; i++) {
    const id = idSize === 2 ? buf.readUInt16BE(at) : buf.readUInt32BE(at);
    at += idSize;
    let constructionMethod = 0;
    if (hasConstruction) {
      constructionMethod = buf.readUInt16BE(at) & 0xf;
      at += 2;
    }
    at += 2; // data_reference_index
    const baseOffset = readUInt(buf, at, baseOffsetSize);
    at += baseOffsetSize;
    const extentCount = buf.readUInt16BE(at);
    at += 2;
    let first: Extent | null = null;
    for (let e = 0; e < extentCount; e++) {
      at += indexSize;
      const offset = readUInt(buf, at, offsetSize);
      at += offsetSize;
      const length = readUInt(buf, at, lengthSize);
      at += lengthSize;
      if (e === 0) first = { offset: baseOffset + offset, length };
    }
    if (id === itemId) return constructionMethod === 0 ? first : null;
  }
  return null;
}

/** HEIC の Exif item の TIFF バイト列。 見つからなければ null。 */
export function extractHeicTiff(buf: Buffer): Buffer | null {
  if (!isHeic(buf)) return null;
  try {
    const meta = readBoxes(buf, 0, buf.length).find((b) => b.type === 'meta');
    if (!meta) return null;
    const children = readBoxes(buf, meta.start + 4, meta.end);
    const iinf = children.find((b) => b.type === 'iinf');
    const iloc = children.find((b) => b.type === 'iloc');
    if (!iinf || !iloc) return null;
    const itemId = findExifItemId(buf, iinf);
    if (itemId === null) return null;
    const extent = findItemExtent(buf, iloc, itemId);
    if (!extent || extent.length < 4 || extent.offset + extent.length > buf.length) return null;
    const tiffStart = extent.offset + 4 + buf.readUInt32BE(extent.offset);
    const end = extent.offset + extent.length;
    return tiffStart < end ? buf.subarray(tiffStart, end) : null;
  } catch {
    return null;
  }
}
