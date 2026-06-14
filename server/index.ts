// Aedilis server entry — Hono + better-sqlite3 + Cernere PASETO V4。
//
// 起動シーケンス:
//   1. env / dirs を解決
//   2. SQLite 開いて schema 適用
//   3. FacilitySource (LocalFacilitySource = JSON) を組み立て
//   4. Cernere 公開鍵 fetch ループ start
//   5. router を mount → listen

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from './db.ts';
import { startAuth } from './auth.ts';
import { LocalFacilitySource } from './facility/local.ts';
import { makeMeRouter } from './routes/me.ts';
import { makeFacilityRouter } from './routes/facilities.ts';
import { makeReservationRouter } from './routes/reservations.ts';
import { makeCheckinRouter } from './routes/checkin.ts';
import { corpusManifest, CORPUS_MANIFEST_PATH } from './corpus.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 必須 env を取り出す。 未設定なら落とす (= localhost 等の暗黙 fallback は禁止)。 */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(
      `[aedilis] ${name} が未設定です。 Infisical / .env.secrets / .env / host env のいずれかで指定してください。`,
    );
    process.exit(1);
  }
  return v.trim();
}

// listen port / data dir / facility master path は default 容認 (= サービスとして成立)
const PORT = Number(process.env.AEDILIS_PORT ?? 17502);
const DATA_DIR = resolve(
  process.env.AEDILIS_DATA && process.env.AEDILIS_DATA.trim()
    ? process.env.AEDILIS_DATA
    : join(__dirname, '..', 'data'),
);
const DB_PATH = join(DATA_DIR, 'aedilis.db');
const FACILITIES_PATH = resolve(
  process.env.AEDILIS_FACILITIES && process.env.AEDILIS_FACILITIES.trim()
    ? process.env.AEDILIS_FACILITIES
    : join(__dirname, '..', 'facilities.json'),
);

// 認証系は必須 — 不正な値で起動して全リクエスト 401 になるより起動を止める
const CERNERE_BASE_URL = requireEnv('CERNERE_BASE_URL');
const AUDIENCE = requireEnv('AEDILIS_PUBLIC_URL');

const ADMIN_IDS = new Set(
  (process.env.AEDILIS_ADMIN_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const db = openDb(DB_PATH);
startAuth({
  cernereBaseUrl: CERNERE_BASE_URL,
  audience: AUDIENCE,
  adminIds: ADMIN_IDS,
});

const facilitySource = new LocalFacilitySource(FACILITIES_PATH);

const app = new Hono();
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);

// 既定ゲートウェイ URL は PWA が会場 LAN アドレスを pre-fill するために配る
// (任意。 未設定なら null = ユーザが画面で入力する。 CONTRACTS §4 PWA 節)。
const DEFAULT_GATEWAY_URL =
  process.env.AEDILIS_DEFAULT_GATEWAY_URL?.trim() || null;

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'aedilis',
    port: PORT,
    defaultGatewayUrl: DEFAULT_GATEWAY_URL,
  }),
);

// Corpus hub 連携 — サービスマニフェスト (認証不要)。 Corpus が読み、
// declarative panel の descriptor を内蔵レンダラで描画する。
app.get(CORPUS_MANIFEST_PATH, (c) => c.json(corpusManifest));

app.route('/api/me', makeMeRouter(db));
app.route('/api/facilities', makeFacilityRouter(db, facilitySource));
app.route('/api/reservations', makeReservationRouter(db, facilitySource));
// 出席チェックイン: /api/checkin/* と /api/admin/gateways をまとめて mount。
app.route('/api', makeCheckinRouter(db));

// serveStatic は cwd 相対なので、 npm scripts は repo root から起動する前提。
app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));
app.notFound((c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/')) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.redirect('/');
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[aedilis] listening on http://localhost:${info.port}`);
  console.log(`[aedilis] data dir: ${DATA_DIR}`);
  console.log(`[aedilis] facilities: ${FACILITIES_PATH}`);
  console.log(`[aedilis] cernere: ${CERNERE_BASE_URL}`);
  console.log(`[aedilis] audience: ${AUDIENCE}`);
  console.log(`[aedilis] admin user ids: ${ADMIN_IDS.size}`);
});
