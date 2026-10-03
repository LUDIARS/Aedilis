# セットアップ

## 前提
- Node.js（Hono + better-sqlite3 + esbuild SPA）。Cernere に到達できること。

## 起動（Excubitor Vault-only）
Excubitor の catalog 定義から起動する。Ex が設定と Vault の秘密情報を env に注入し、
`server/bootstrap.ts` が必須項目を検査してから本体を import する。
未設定・空文字・空白のみの必須項目は変数名だけを示して停止する。
非秘密設定は `excubitor.catalog.yaml` の `env:`、秘密情報は Ex の Vault binding が正本。
注入優先順位は topology < catalog env < 暗号化 runtime config < Vault。
アプリは dotenv 読み込み・secret store 接続を行わない。

## env
| 変数 | 要否 | 用途 |
|---|---|---|
| `CERNERE_BASE_URL` | 必須 | Cernere（公開鍵 fetch / SSO）のベース URL |
| `AEDILIS_PUBLIC_URL` | 必須 | 自身の公開 URL（manifest / リダイレクト） |
| `CERNERE_PROJECT_CLIENT_ID` | 必須 | Cernere プロジェクト API の短期 client ID。Excubitor 起動時に注入される |
| `CERNERE_PROJECT_CLIENT_SECRET` | 必須 | Cernere プロジェクト API の短期 client secret。Excubitor 起動時に注入される |
| `AEDILIS_PORT` | 任意（既定 17502） | listen ポート |
| `AEDILIS_ADMIN_IDS` | 任意 | admin 操作を許す Cernere user id（カンマ区切り） |
| `AEDILIS_DATA` | 任意 | SQLite データの場所 |
| `CHECKIN_MIN_ASSURANCE` | 任意 | 出席で受理する最低 assurance（既定 `medium`、`low` は明示設定時のみ） |
| `CHECKIN_PASSKEY_STREAK_WARN` | 任意 | passkey のみの連続利用を管理一覧で注意表示する日数（既定 `5`） |

> 出席チェックインを本番配線するときは、WebAuthn の RP ID / origin を
> Cernere / Ostiarius と同一 eTLD+1 に揃える必要がある。横断 env 配線は
> [`./webauthn-rp-id.md`](./webauthn-rp-id.md) を参照。

> `CERNERE_PROJECT_CLIENT_*` は固定値として保存せず、Excubitor が Cernere から
> 起動ごとに発行を受けて注入する。`AEDILIS_ADMIN_IDS` は未設定でも起動できる。

## ポート
- `17502`（LUDIARS loopback レンジ）。17500 は Dropbox squat、17501 は Bibliotheca。

## デプロイ
- 詳細・起動モードは [`../../DESIGN.md`](../../DESIGN.md) §9。
