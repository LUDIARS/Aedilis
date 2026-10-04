// GPS チェックイン (CONTRACTS §6 G3) の検証 1: multipart 入力の形式検査。
// HTTP の body 解析結果を受け取り、 型付きの入力か固定語彙のエラーコードを返す。

import { matchesPhotoMagic, type PhotoMime } from './exif/index.ts';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const PHOTO_MIMES: readonly PhotoMime[] = ['image/jpeg', 'image/heic'];

export interface GpsCheckinInput {
  locationStatement: string;
  lat: number;
  lon: number;
  accuracyM: number;
  /** epoch ms (端末の測位時刻)。 */
  positionAt: number;
  photo: { bytes: Buffer; mime: PhotoMime };
}

export type GpsInputResult =
  | { ok: true; input: GpsCheckinInput }
  | { ok: false; error: 'invalid_input' | 'photo_invalid' };

type FormValue = string | File | Array<string | File> | undefined;

function field(form: Record<string, FormValue>, name: string): string | null {
  const v = form[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function numberField(form: Record<string, FormValue>, name: string): number | null {
  const raw = field(form, name);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** positionAt は epoch ms の数値文字列、 または ISO 8601 文字列を受ける。 */
function timeField(form: Record<string, FormValue>, name: string): number | null {
  const numeric = numberField(form, name);
  if (numeric !== null) return numeric;
  const raw = field(form, name);
  const parsed = raw === null ? NaN : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPhotoMime(type: string): type is PhotoMime {
  return (PHOTO_MIMES as readonly string[]).includes(type);
}

export async function parseGpsCheckinForm(form: Record<string, FormValue>): Promise<GpsInputResult> {
  const locationStatement = field(form, 'locationStatement');
  const lat = numberField(form, 'lat');
  const lon = numberField(form, 'lon');
  const accuracyM = numberField(form, 'accuracyM');
  const positionAt = timeField(form, 'positionAt');
  if (
    locationStatement === null ||
    lat === null || lat < -90 || lat > 90 ||
    lon === null || lon < -180 || lon > 180 ||
    accuracyM === null || accuracyM <= 0 ||
    positionAt === null
  ) {
    return { ok: false, error: 'invalid_input' };
  }

  const photo = form.photo;
  if (!(photo instanceof File)) return { ok: false, error: 'invalid_input' };
  const mime = photo.type.toLowerCase();
  if (!isPhotoMime(mime) || photo.size === 0 || photo.size > MAX_PHOTO_BYTES) {
    return { ok: false, error: 'photo_invalid' };
  }
  const bytes = Buffer.from(await photo.arrayBuffer());
  if (bytes.length > MAX_PHOTO_BYTES || !matchesPhotoMagic(bytes, mime)) {
    return { ok: false, error: 'photo_invalid' };
  }
  return { ok: true, input: { locationStatement, lat, lon, accuracyM, positionAt, photo: { bytes, mime } } };
}
