// 写真 Exif 読み取り (server/checkin/exif/) のユニットテスト。

import { describe, expect, it } from 'vitest';
import { exifTakenAtMs, matchesPhotoMagic, readPhotoExif } from '../server/checkin/exif/index.ts';
import { buildHeic, buildJpeg } from './fixtures/photo-exif.ts';

describe('readPhotoExif', () => {
  it('reads DateTimeOriginal, OffsetTimeOriginal and GPS from a big-endian JPEG APP1', () => {
    const jpeg = buildJpeg({
      dateTimeOriginal: '2026:10:05 10:00:00',
      offsetTimeOriginal: '+09:00',
      gps: { lat: 35.681236, lon: 139.767125 },
    });
    const exif = readPhotoExif(jpeg, 'image/jpeg');
    expect(exif.dateTimeOriginal).toBe('2026:10:05 10:00:00');
    expect(exif.offsetTimeOriginal).toBe('+09:00');
    expect(exif.gpsLat).toBeCloseTo(35.681236, 6);
    expect(exif.gpsLon).toBeCloseTo(139.767125, 6);
  });

  it('reads a little-endian TIFF and applies S/W references as negative degrees', () => {
    const jpeg = buildJpeg({ dateTimeOriginal: '2026:10:05 10:00:00', gps: { lat: -33.8688, lon: -70.6693 } }, true);
    const exif = readPhotoExif(jpeg, 'image/jpeg');
    expect(exif.dateTimeOriginal).toBe('2026:10:05 10:00:00');
    expect(exif.gpsLat).toBeCloseTo(-33.8688, 6);
    expect(exif.gpsLon).toBeCloseTo(-70.6693, 6);
  });

  it('reads the Exif item of a HEIC file', () => {
    const heic = buildHeic({ dateTimeOriginal: '2026:10:05 10:00:00', gps: { lat: 35.0, lon: 135.0 } });
    expect(matchesPhotoMagic(heic, 'image/heic')).toBe(true);
    const exif = readPhotoExif(heic, 'image/heic');
    expect(exif.dateTimeOriginal).toBe('2026:10:05 10:00:00');
    expect(exif.gpsLat).toBeCloseTo(35.0, 6);
    expect(exif.gpsLon).toBeCloseTo(135.0, 6);
  });

  it('returns an empty object when the photo has no Exif or is corrupt', () => {
    expect(readPhotoExif(buildJpeg(null), 'image/jpeg')).toEqual({});
    const truncated = buildJpeg({ dateTimeOriginal: '2026:10:05 10:00:00' }).subarray(0, 40);
    expect(() => readPhotoExif(truncated, 'image/jpeg')).not.toThrow();
    expect(readPhotoExif(Buffer.from('not a photo'), 'image/heic')).toEqual({});
  });

  it('checks the magic bytes against the declared type', () => {
    expect(matchesPhotoMagic(buildJpeg(null), 'image/jpeg')).toBe(true);
    expect(matchesPhotoMagic(buildJpeg(null), 'image/heic')).toBe(false);
    expect(matchesPhotoMagic(buildHeic({}), 'image/jpeg')).toBe(false);
  });
});

describe('exifTakenAtMs', () => {
  it('applies OffsetTimeOriginal when present', () => {
    expect(exifTakenAtMs({ dateTimeOriginal: '2026:10:05 01:00:00', offsetTimeOriginal: '+00:00' }, '+09:00'))
      .toBe(Date.parse('2026-10-05T01:00:00Z'));
  });

  it('falls back to the facility offset (Asia/Tokyo) when no offset is recorded', () => {
    expect(exifTakenAtMs({ dateTimeOriginal: '2026:10:05 10:00:00' }, '+09:00'))
      .toBe(Date.parse('2026-10-05T01:00:00Z'));
  });

  it('returns null for a missing or malformed DateTimeOriginal', () => {
    expect(exifTakenAtMs({}, '+09:00')).toBeNull();
    expect(exifTakenAtMs({ dateTimeOriginal: '0000:00:00 00:00:00' }, '+09:00')).toBeNull();
    expect(exifTakenAtMs({ dateTimeOriginal: '2026-10-05 10:00' }, '+09:00')).toBeNull();
  });
});
