// GPS チェックインのテスト用に、 Exif を埋めた最小の JPEG / HEIC を合成する。
// 画像データ自体は持たない (Exif 読み取りとハッシュ計算に必要な構造だけ)。

import { generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { b64urlEncode } from '../../server/checkin/attestation.ts';

export interface ExifSpec {
  dateTimeOriginal?: string;
  offsetTimeOriginal?: string;
  gps?: { lat: number; lon: number };
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  data: Buffer;
}

function writer(little: boolean) {
  return {
    u16(n: number): Buffer {
      const b = Buffer.alloc(2);
      if (little) b.writeUInt16LE(n);
      else b.writeUInt16BE(n);
      return b;
    },
    u32(n: number): Buffer {
      const b = Buffer.alloc(4);
      if (little) b.writeUInt32LE(n);
      else b.writeUInt32BE(n);
      return b;
    },
  };
}

function ascii(s: string): Entry['data'] {
  return Buffer.from(`${s}\0`, 'latin1');
}

/** TIFF/Exif バイト列 (DateTimeOriginal / OffsetTimeOriginal / GPS) を組み立てる。 */
export function buildTiff(spec: ExifSpec, little = false): Buffer {
  const w = writer(little);
  const rational = (deg: number): Buffer => {
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const m = Math.floor((abs - d) * 60);
    const s = Math.round(((abs - d) * 60 - m) * 60 * 1_000_000);
    return Buffer.concat([w.u32(d), w.u32(1), w.u32(m), w.u32(1), w.u32(s), w.u32(1_000_000)]);
  };
  const asciiEntry = (tag: number, s: string): Entry => ({ tag, type: 2, count: s.length + 1, data: ascii(s) });

  const exifEntries: Entry[] = [];
  if (spec.dateTimeOriginal) exifEntries.push(asciiEntry(0x9003, spec.dateTimeOriginal));
  if (spec.offsetTimeOriginal) exifEntries.push(asciiEntry(0x9011, spec.offsetTimeOriginal));
  const gpsEntries: Entry[] = spec.gps
    ? [
        asciiEntry(0x0001, spec.gps.lat < 0 ? 'S' : 'N'),
        { tag: 0x0002, type: 5, count: 3, data: rational(spec.gps.lat) },
        asciiEntry(0x0003, spec.gps.lon < 0 ? 'W' : 'E'),
        { tag: 0x0004, type: 5, count: 3, data: rational(spec.gps.lon) },
      ]
    : [];

  const ifdSize = (n: number) => 2 + 12 * n + 4;
  const ifd0Count = 1 + (spec.gps ? 1 : 0);
  const exifOffset = 8 + ifdSize(ifd0Count);
  const gpsOffset = exifOffset + ifdSize(exifEntries.length);
  let dataOffset = gpsOffset + (spec.gps ? ifdSize(gpsEntries.length) : 0);
  const ifd0: Entry[] = [{ tag: 0x8769, type: 4, count: 1, data: w.u32(exifOffset) }];
  if (spec.gps) ifd0.push({ tag: 0x8825, type: 4, count: 1, data: w.u32(gpsOffset) });

  const dataParts: Buffer[] = [];
  const encodeIfd = (entries: Entry[]): Buffer => {
    const parts = [w.u16(entries.length)];
    for (const e of entries) {
      parts.push(w.u16(e.tag), w.u16(e.type), w.u32(e.count));
      if (e.data.length <= 4) {
        parts.push(Buffer.concat([e.data, Buffer.alloc(4 - e.data.length)]));
      } else {
        parts.push(w.u32(dataOffset));
        dataParts.push(e.data);
        dataOffset += e.data.length;
      }
    }
    parts.push(w.u32(0));
    return Buffer.concat(parts);
  };

  const header = Buffer.concat([Buffer.from(little ? 'II' : 'MM', 'latin1'), w.u16(42), w.u32(8)]);
  const ifds = [encodeIfd(ifd0), encodeIfd(exifEntries)];
  if (spec.gps) ifds.push(encodeIfd(gpsEntries));
  return Buffer.concat([header, ...ifds, ...dataParts]);
}

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** Exif 付き JPEG。 spec が null なら APP1 を持たない JPEG。 毎回バイト列は一意。 */
export function buildJpeg(spec: ExifSpec | null, little = false): Buffer {
  const parts = [Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'))];
  if (spec) parts.push(segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), buildTiff(spec, little)])));
  parts.push(segment(0xfe, randomBytes(16)), segment(0xda, Buffer.alloc(10)), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

function fullBox(type: string, version: number, payload: Buffer): Buffer {
  return box(type, Buffer.concat([Buffer.from([version, 0, 0, 0]), payload]));
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** Exif item を持つ最小の HEIC (ftyp / meta[iinf, iloc] / mdat)。 毎回バイト列は一意。 */
export function buildHeic(spec: ExifSpec): Buffer {
  const ftyp = box('ftyp', Buffer.from('heic\0\0\0\0mif1heic', 'latin1'));
  const exifItem = Buffer.concat([u32(6), Buffer.from('Exif\0\0', 'latin1'), buildTiff(spec)]);
  const infe = fullBox('infe', 2, Buffer.concat([u16(1), u16(0), Buffer.from('Exif\0', 'latin1')]));
  const iinf = fullBox('iinf', 0, Buffer.concat([u16(1), infe]));
  const ilocFor = (offset: number) =>
    fullBox('iloc', 0, Buffer.concat([Buffer.from([0x44, 0x00]), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(exifItem.length)]));
  const meta = (offset: number) => fullBox('meta', 0, Buffer.concat([iinf, ilocFor(offset)]));
  const free = box('free', randomBytes(16));
  const mdatPayloadAt = ftyp.length + meta(0).length + free.length + 8;
  return Buffer.concat([ftyp, meta(mdatPayloadAt), free, box('mdat', exifItem)]);
}

/** epoch ms を "+09:00" 表記の Exif DateTimeOriginal ("YYYY:MM:DD HH:MM:SS") にする。 */
export function exifDateTime(ms: number, offsetMinutes = 540): string {
  const iso = new Date(ms + offsetMinutes * 60_000).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, ':')} ${iso.slice(11, 19)}`;
}

/** 位置の宣言 (G1) の署名役。 */
export function makeGatewayKeys(): { privateKey: KeyObject; publicKeyPem: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function signStatement(payload: Record<string, unknown>, key: KeyObject): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64urlEncode(cryptoSign(null, Buffer.from(body), key))}`;
}

/** 緯度方向に meters だけずらした緯度 (haversine と同じ地球半径)。 */
export function latOffset(lat: number, meters: number): number {
  return lat + (meters / 6_371_008.8) * (180 / Math.PI);
}
