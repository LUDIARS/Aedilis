// ルーター結線テスト — 未認証リクエストが 401 で弾かれることを検証する。
//
// 認証済の業務ロジックは db.test.ts でカバーする。 ここでは requireAuth
// ゲートが全保護エンドポイントに掛かっていること (= 認証なしで漏れない)
// を確認する。 Cernere 公開鍵が無くてもトークン未提示なら 401 になる。

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { openDb } from '../server/db.ts';
import { LocalFacilitySource } from '../server/facility/local.ts';
import { makeFacilityRouter } from '../server/routes/facilities.ts';
import { makeMeRouter } from '../server/routes/me.ts';
import { makeReservationRouter } from '../server/routes/reservations.ts';

function buildApp(): Hono {
  const db = openDb(':memory:');
  // 存在しないパス → 空の施設ソース (このテストでは施設は引かない)。
  const source = new LocalFacilitySource('/__aedilis_no_facilities__.json');
  const app = new Hono();
  app.route('/api/me', makeMeRouter(db));
  app.route('/api/facilities', makeFacilityRouter(db, source));
  app.route('/api/reservations', makeReservationRouter(db, source));
  return app;
}

const protectedRoutes: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/me' },
  { method: 'GET', path: '/api/facilities' },
  { method: 'GET', path: '/api/facilities/room-a' },
  { method: 'GET', path: '/api/reservations' },
  { method: 'GET', path: '/api/reservations/mine' },
  { method: 'POST', path: '/api/reservations' },
  { method: 'PATCH', path: '/api/reservations/some-id' },
  { method: 'DELETE', path: '/api/reservations/some-id' },
];

describe('auth gate', () => {
  const app = buildApp();

  for (const { method, path } of protectedRoutes) {
    it(`rejects unauthenticated ${method} ${path} with 401`, async () => {
      const init: RequestInit = { method };
      if (method === 'POST' || method === 'PATCH') {
        init.headers = { 'content-type': 'application/json' };
        init.body = '{}';
      }
      const res = await app.request(path, init);
      expect(res.status).toBe(401);
    });
  }

  it('responds with an unauthorized error body', async () => {
    const res = await app.request('/api/me');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 404 for an unknown route (no auth leak)', async () => {
    const res = await app.request('/api/nonexistent');
    expect(res.status).toBe(404);
  });
});
