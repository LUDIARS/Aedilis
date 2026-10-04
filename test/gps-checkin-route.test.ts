// POST /api/checkin/gps (CONTRACTS §6 G3) の HTTP 境界テスト。
// 認証は x-test-user ヘッダで差し替える (Cernere 不要)。

import { Hono, type Context, type Next } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertGateway } from '../server/db.ts';
import { SlidingWindowLimiter } from '../server/checkin/rate-limit.ts';
import { makeCheckinRouter } from '../server/routes/checkin.ts';
import type { AuthIdentity } from '../server/auth.ts';
import { buildJpeg, exifDateTime, makeGatewayKeys, signStatement } from './fixtures/photo-exif.ts';

vi.mock('../server/auth.ts', () => {
  const identity = (c: Context): AuthIdentity | null => c.req.header('x-test-user') ? {
    userId: c.req.header('x-test-user') || '', isAdmin: false, role: 'general', displayName: null, projectKey: 'aedilis',
  } : null;
  return {
    getIdentity: (c: Context) => c.get('auth'),
    requireAuth: async (c: Context, next: Next) => {
      const user = identity(c);
      if (!user) return c.json({ error: 'unauthorized' }, 401);
      c.set('auth', user);
      await next();
    },
    requireAdmin: async (_c: Context, next: Next) => next(),
  };
});

const VENUE = { lat: 35.681236, lon: 139.767125, radiusM: 50 };

function setup(limiter?: SlidingWindowLimiter) {
  const db = openDb(':memory:');
  const keys = makeGatewayKeys();
  upsertGateway(db, { lanId: 'lan-gps', publicKeyPem: keys.publicKeyPem, facilityId: 'room-101', tokenHash: 'gps-route-hash' });
  const app = new Hono().route('/api', makeCheckinRouter(db, undefined, { gpsRateLimiter: limiter }));
  const locationStatement = signStatement(
    { lanId: 'lan-gps', facilityId: 'room-101', ...VENUE, issuedAt: Date.now(), purpose: 'location' },
    keys.privateKey,
  );
  return { app, db, locationStatement };
}

function form(fields: Record<string, string>, photo?: Blob, filename = 'photo.jpg'): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (photo) fd.set('photo', photo, filename);
  return fd;
}

function validFields(locationStatement: string): Record<string, string> {
  return {
    locationStatement,
    lat: String(VENUE.lat),
    lon: String(VENUE.lon),
    accuracyM: '12',
    positionAt: String(Date.now()),
  };
}

function jpegBlob(bytes: Buffer = buildJpeg({ dateTimeOriginal: exifDateTime(Date.now()) })): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
}

function post(app: Hono, body: FormData, user: string | null = 'student-1') {
  return app.request('/api/checkin/gps', { method: 'POST', body, headers: user ? { 'x-test-user': user } : {} });
}

describe('POST /api/checkin/gps', () => {
  it('requires a Cernere identity', async () => {
    const { app, locationStatement } = setup();
    expect((await post(app, form(validFields(locationStatement), jpegBlob()), null)).status).toBe(401);
  });

  it('records a GPS check-in and returns { ok, attendanceId }', async () => {
    const { app, db, locationStatement } = setup();
    const response = await post(app, form(validFields(locationStatement), jpegBlob()));
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; attendanceId: string };
    expect(body).toEqual({ ok: true, attendanceId: expect.any(String) });
    const row = db.prepare('SELECT user_id, method, assurance FROM attendance WHERE id = ?').get(body.attendanceId);
    expect(row).toEqual({ user_id: 'student-1', method: 'gps', assurance: 'low' });
  });

  it('rejects malformed fields with invalid_input', async () => {
    const { app, locationStatement } = setup(new SlidingWindowLimiter(100, 60_000));
    const cases: Array<Record<string, string>> = [
      { ...validFields(locationStatement), lat: '91' },
      { ...validFields(locationStatement), lon: '-181' },
      { ...validFields(locationStatement), accuracyM: '0' },
      { ...validFields(locationStatement), positionAt: 'yesterday' },
      { ...validFields(locationStatement), locationStatement: '' },
    ];
    for (const fields of cases) {
      const response = await post(app, form(fields, jpegBlob()));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_input' });
    }
    const noPhoto = await post(app, form(validFields(locationStatement)));
    expect(await noPhoto.json()).toEqual({ error: 'invalid_input' });
  });

  it('rejects unsupported, mislabeled or oversized photos with photo_invalid', async () => {
    const { app, locationStatement } = setup(new SlidingWindowLimiter(100, 60_000));
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    const fakeJpeg = new Blob([new Uint8Array(Buffer.from('not a jpeg'))], { type: 'image/jpeg' });
    const huge = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/jpeg' });
    for (const photo of [png, fakeJpeg, huge]) {
      const response = await post(app, form(validFields(locationStatement), photo));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(await response.json()).toEqual({ error: 'photo_invalid' });
    }
  });

  it('maps a reused photo to 409 photo_reused', async () => {
    const { app, locationStatement } = setup();
    const bytes = buildJpeg({ dateTimeOriginal: exifDateTime(Date.now()) });
    expect((await post(app, form(validFields(locationStatement), jpegBlob(bytes)))).status).toBe(200);
    const again = await post(app, form(validFields(locationStatement), jpegBlob(bytes)), 'student-2');
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'photo_reused' });
  });

  it('rate-limits each user to 5 attempts per minute', async () => {
    const { app, locationStatement } = setup();
    const bad = { ...validFields(locationStatement), lat: 'x' };
    for (let i = 0; i < 5; i++) {
      expect((await post(app, form(bad, jpegBlob()))).status).toBe(400);
    }
    const limited = await post(app, form(bad, jpegBlob()));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    // 他の利用者は影響を受けない
    expect((await post(app, form(bad, jpegBlob()), 'student-2')).status).toBe(400);
  });
});

describe('SlidingWindowLimiter', () => {
  it('frees capacity once the window passes', () => {
    const limiter = new SlidingWindowLimiter(2, 1_000);
    expect(limiter.tryConsume('u', 0)).toBe(true);
    expect(limiter.tryConsume('u', 10)).toBe(true);
    expect(limiter.tryConsume('u', 20)).toBe(false);
    expect(limiter.tryConsume('u', 1_001)).toBe(true);
  });
});
