# Aedilis

LUDIARS の **施設予約サービス**。 同時に「予定の登録/反映」 を担い、 Schedula /
Google Calendar と双方向連携する (連携は v0.3 以降)。

短縮コード: **Ae**

## ログイン不要の日程調整

`/meetings` から会議の候補日時・会場予定を登録してURLを共有できます。
共有URLは `/meeting/{UUID}` です。標準の開始・終了時刻を保存し、カレンダーで候補日を複数選べます。
参加者は日程ごとの ○・△・× と ONLINE、全体の「基本ONLINE」で回答できます。
参加者は名前、可否、コメント、話したい内容を記入し、同じ端末で自分の回答を編集・削除できます。
Cernereに登録・ログインして回答を引き継ぐと、複数端末で編集できます。
Googleカレンダー読み込みとDiscord通知の設定は
[meeting-integrations.md](spec/setup/meeting-integrations.md) を参照してください。
会議の日時確定は日程調整上の確定で、管理施設の予約確保は別途必要です。

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
> 横断 env 配線は [`spec/setup/webauthn-rp-id.md`](spec/setup/webauthn-rp-id.md)。

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

必須 env: `CERNERE_BASE_URL`、 `AEDILIS_PUBLIC_URL`、
`CERNERE_PROJECT_CLIENT_ID`、`CERNERE_PROJECT_CLIENT_SECRET`。
後者 2 つは Excubitor 起動時に Cernere が都度発行して子プロセスへ注入する。
Excubitor を介さず直接起動する場合は、同等の短期プロジェクト資格情報を環境変数で
明示的に与える必要がある（Infisical に固定の長期資格情報を保存しない）。
任意: `AEDILIS_PORT` (既定 17502)、 `AEDILIS_ADMIN_IDS`、 `AEDILIS_DATA`、
`AEDILIS_FACILITIES` (施設マスタ JSON のパス、 既定はリポ直下 `facilities.json`)。

出席チェックイン用 (任意):
- `MEMORIA_WEBHOOK_URL` — 出席イベントの送信先。**既定の向き先は Imperativus /
  Legatus relay の出席エンドポイント** (relay → Memoria ingest)。Memoria を直接
  叩く構成にはしない (Memoria は online 直接 write 不可)。未設定なら送らない。
- `AEDILIS_DEFAULT_GATEWAY_URL` — PWA に pre-fill する既定の会場ゲートウェイ URL。

> 本番で出席チェックインを成立させるには、WebAuthn の RP ID / origin を
> Cernere / Ostiarius と同一 eTLD+1 に揃える必要がある。3 サービスの env 配線は
> [`spec/setup/webauthn-rp-id.md`](spec/setup/webauthn-rp-id.md) を参照。

## ポート

`17502` — LUDIARS loopback レンジ。 17500 は Dropbox squat、 17501 は Bibliotheca。

## ライセンス

リポジトリの LICENSE に準ずる。
