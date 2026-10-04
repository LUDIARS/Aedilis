// TIFF/Exif IFD の最小パーサ。 GPS チェックイン (CONTRACTS §6 G3-5) に必要な
// DateTimeOriginal / OffsetTimeOriginal / GPS 緯度経度だけを読む。
//
// 入力は "II*\0" / "MM\0*" で始まる TIFF ヘッダ以降のバイト列 (JPEG APP1 や
// HEIC Exif item から取り出したもの)。 壊れた入力は例外ではなく null 扱いにする。

export interface ExifFields {
  /** "YYYY:MM:DD HH:MM:SS" (Exif の ASCII 形式そのまま)。 */
  dateTimeOriginal?: string;
  /** "+09:00" 形式。 Exif 2.31 以降のカメラだけが書く。 */
  offsetTimeOriginal?: string;
  /** 10 進度 (南緯・西経は負)。 GPS IFD が無い/不完全なら undefined。 */
  gpsLat?: number;
  gpsLon?: number;
}

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LON_REF = 0x0003;
const TAG_GPS_LON = 0x0004;

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const MAX_IFD_ENTRIES = 1024;

interface IfdEntry {
  type: number;
  count: number;
  /** 値本体の先頭位置 (4 byte 以下ならエントリ内、 超えればオフセット先)。 */
  valueOffset: number;
}

class TiffReader {
  constructor(private readonly buf: Buffer, private readonly little: boolean) {}

  u16(at: number): number {
    this.need(at, 2);
    return this.little ? this.buf.readUInt16LE(at) : this.buf.readUInt16BE(at);
  }

  u32(at: number): number {
    this.need(at, 4);
    return this.little ? this.buf.readUInt32LE(at) : this.buf.readUInt32BE(at);
  }

  need(at: number, len: number): void {
    if (at < 0 || at + len > this.buf.length) throw new RangeError('tiff out of bounds');
  }

  readIfd(offset: number): Map<number, IfdEntry> {
    const entries = new Map<number, IfdEntry>();
    const count = this.u16(offset);
    if (count > MAX_IFD_ENTRIES) throw new RangeError('tiff ifd too large');
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      const tag = this.u16(at);
      const type = this.u16(at + 2);
      const n = this.u32(at + 4);
      const size = (TYPE_SIZES[type] ?? 0) * n;
      const valueOffset = size <= 4 ? at + 8 : this.u32(at + 8);
      entries.set(tag, { type, count: n, valueOffset });
    }
    return entries;
  }

  ascii(entry: IfdEntry | undefined): string | undefined {
    if (!entry || entry.type !== 2 || entry.count === 0) return undefined;
    this.need(entry.valueOffset, entry.count);
    const raw = this.buf.toString('latin1', entry.valueOffset, entry.valueOffset + entry.count);
    const nul = raw.indexOf('\0');
    return (nul >= 0 ? raw.slice(0, nul) : raw).trim();
  }

  /** RATIONAL×3 (度・分・秒) → 10 進度。 */
  degrees(entry: IfdEntry | undefined): number | undefined {
    if (!entry || entry.type !== 5 || entry.count < 3) return undefined;
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const num = this.u32(entry.valueOffset + i * 8);
      const den = this.u32(entry.valueOffset + i * 8 + 4);
      if (den === 0) return undefined;
      total += num / den / 60 ** i;
    }
    return total;
  }
}

function readGps(reader: TiffReader, offset: number): Pick<ExifFields, 'gpsLat' | 'gpsLon'> {
  const gps = reader.readIfd(offset);
  const lat = reader.degrees(gps.get(TAG_GPS_LAT));
  const lon = reader.degrees(gps.get(TAG_GPS_LON));
  if (lat === undefined || lon === undefined) return {};
  const latRef = reader.ascii(gps.get(TAG_GPS_LAT_REF));
  const lonRef = reader.ascii(gps.get(TAG_GPS_LON_REF));
  return {
    gpsLat: latRef === 'S' ? -lat : lat,
    gpsLon: lonRef === 'W' ? -lon : lon,
  };
}

/** TIFF バイト列から必要な Exif 項目を読む。 TIFF として読めなければ null。 */
export function parseTiffExif(buf: Buffer): ExifFields | null {
  try {
    if (buf.length < 8) return null;
    const order = buf.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const reader = new TiffReader(buf, order === 'II');
    if (reader.u16(2) !== 42) return null;
    const ifd0 = reader.readIfd(reader.u32(4));

    const fields: ExifFields = {};
    const exifPtr = ifd0.get(TAG_EXIF_IFD);
    if (exifPtr) {
      const exif = reader.readIfd(reader.u32(exifPtr.valueOffset));
      fields.dateTimeOriginal = reader.ascii(exif.get(TAG_DATETIME_ORIGINAL)) || undefined;
      fields.offsetTimeOriginal = reader.ascii(exif.get(TAG_OFFSET_TIME_ORIGINAL)) || undefined;
    }
    const gpsPtr = ifd0.get(TAG_GPS_IFD);
    if (gpsPtr) Object.assign(fields, readGps(reader, reader.u32(gpsPtr.valueOffset)));
    return fields;
  } catch {
    return null;
  }
}
