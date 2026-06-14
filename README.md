# Aedilis

LUDIARS の **施設予約サービス**。 同時に「予定の登録/反映」 を担い、 Schedula /
Google Calendar と双方向連携する (連携は v0.3 以降)。

短縮コード: **Ae**

> 名の由来: 古代ローマの **aedilis** — 公共建物・市場・公式祭礼カレンダーを
> 統括した官職。 「施設管理 + 行事スケジュール」 が職務そのまま。

## 機能 (v0.2)

- **施設一覧** — 会議室・ホール等のマスタを参照 (`FacilitySource` 抽象、 v0.2 は JSON)
- **予約 CRUD** — 作成 / 一覧 / 時刻・目的の修正 / キャンセル
- **重複検知** — 同一施設 × 時間帯の重複を 409 で拒否 (重複可フラグ付き施設は許可)
- **admin 操作** — 代理キャンセル / 重複可フラグ切替
- 認証は Cernere PASETO V4 (公開鍵 fetch)

カレンダー連携 (Schedula / Google) は v0.3 以降。 設計は [DESIGN.md](./DESIGN.md)。

## 出席チェックイン (投機実装 / `checkin-spike/CONTRACTS.md`)

会場 LAN ゲートウェイ (Ostiarius) が passkey で本人検証 → Ed25519 で attestation
を署名 → PWA がクラウド (Aedilis) へリレー → Aedilis が公開鍵で検証して出席記録。

- **PWA**: `/checkin.html` — ゲートウェイ URL 設定 + チェックインボタン + 履歴
- **検証**: `POST /api/checkin/verify` が 署名 → 本人性 → 鮮度 (120s) → replay
  (nonce UNIQUE → 409) → 予約照合 → 記録 → Memoria webhook の順で処理
- **admin**: `POST/GET /api/admin/gateways` でゲートウェイ公開鍵 PEM を登録/一覧
- 個人データは Cernere sub アンカーのみ (`attendance` テーブル)

### check-in API

| Method | Path | 認証 | 役割 |
|---|---|---|---|
| POST | `/api/checkin/verify`   | user  | attestation 検証 → 出席記録 |
| GET  | `/api/checkin/mine`     | user  | 自分の出席履歴 |
| GET  | `/api/checkin?facility=&from=&to=` | admin | 出席一覧 |
| POST | `/api/admin/gateways`   | admin | ゲートウェイ公開鍵 upsert |
| GET  | `/api/admin/gateways`   | admin | ゲートウェイ一覧 |

> Ostiarius / PWA / Cernere の origin・RP ID は同一 eTLD+1 に揃える前提
> (passkey assertion がゲートウェイで検証できるようにするため)。

## 構成

- 単一 Hono アプリ (`server/`) が REST API + 静的 SPA を提供
- 永続化は SQLite (`data/aedilis.db`、 better-sqlite3 / WAL)
- フロントエンドは esbuild + vanilla TypeScript
- 施設マスタは `facilities.json` (`FacilitySource` 抽象で差替可能)

## 起動

Bibliotheca と同じ env bootstrap (Infisical / `.env` / host env の多段)。

```bash
npm install
npm run dev        # tsx watch、 public/app.js を build してから起動
```

必須 env: `CERNERE_BASE_URL`、 `AEDILIS_PUBLIC_URL`。
任意: `AEDILIS_PORT` (既定 17502)、 `AEDILIS_ADMIN_IDS`、 `AEDILIS_DATA`、
`AEDILIS_FACILITIES` (施設マスタ JSON のパス、 既定はリポ直下 `facilities.json`)。

出席チェックイン用 (任意):
- `MEMORIA_WEBHOOK_URL` — 出席イベントの送信先 (Imperativus relay の受け口)。
  未設定なら webhook を送らない。
- `AEDILIS_DEFAULT_GATEWAY_URL` — PWA に pre-fill する既定の会場ゲートウェイ URL。

## ポート

`17502` — LUDIARS loopback レンジ。 17500 は Dropbox squat、 17501 は Bibliotheca。

## ライセンス

リポジトリの LICENSE に準ずる。
