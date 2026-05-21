import type { EnvCliConfig } from "../Cernere/packages/env-cli/src/types.js";

/**
 * Aedilis の env-cli 設定。
 *
 * INFISICAL_* (machine identity) は env-cli setup で .env.secrets に保存。
 * アプリ secret (CERNERE_BASE_URL / AEDILIS_ADMIN_IDS 等) は Infisical 側に置き、
 * bootstrap.ts の env-bootstrap が起動時に fetch + inject する。
 * Memoria / Cernere / Bibliotheca と同パターン。
 */

const config: EnvCliConfig = {
  name: "Aedilis",

  infraKeys: {
    // ─── Hono listen port (loopback only) ────────────────────
    // 17500 は Dropbox squat、 17501 は Bibliotheca。 隣の 17502 を採用。
    AEDILIS_PORT: "17502",

    // ─── データ保存ディレクトリ (SQLite + facility master JSON) ─
    // 既定: server/../data/ (= リポ直下の data/、 gitignore 済)
    AEDILIS_DATA: "",

    // ─── Cernere 認証 (PASETO V4 公開鍵 fetch 先) ────────────
    CERNERE_BASE_URL: "",

    // ─── このサービス自身の public URL (PASETO audience claim) ─
    AEDILIS_PUBLIC_URL: "http://localhost:17502",

    // ─── Cernere project key ─────────────────────────────────
    AEDILIS_PROJECT_KEY: "aedilis",

    // ─── Admin user IDs (Cernere sub claim をカンマ区切り) ────
    // 代理キャンセル / 重複可フラグ切替はこのリストの user のみ。
    AEDILIS_ADMIN_IDS: "",

    // ─── Schedula (予定基盤) の API ベース — v0.3 のカレンダー連携で使用 ─
    SCHEDULA_BASE_URL: "",
  },

  secretsPath: ".env.secrets",
  dotenvPath: ".env",

  defaultSiteUrl: "https://infisical.vtn-game.com",
  defaultEnvironment: "dev",

  required: {
    production: [
      "CERNERE_BASE_URL",
      "AEDILIS_ADMIN_IDS",
      "AEDILIS_PUBLIC_URL",
    ],
  },
};

export default config;
