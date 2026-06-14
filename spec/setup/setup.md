# セットアップ

## 前提
- Node.js（Hono + better-sqlite3 + esbuild SPA）。Cernere に到達できること。

## 起動（Bibliotheca と同型の env bootstrap）
Infisical / `.env` / host env の多段。起動時に env-bootstrap が順に拾う。
```sh
npm run dev    # tsx watch。public/app.js を build してから起動
```

## env
| 変数 | 要否 | 用途 |
|---|---|---|
| `CERNERE_BASE_URL` | 必須 | Cernere（公開鍵 fetch / SSO）のベース URL |
| `AEDILIS_PUBLIC_URL` | 必須 | 自身の公開 URL（manifest / リダイレクト） |
| `AEDILIS_PORT` | 任意（既定 17502） | listen ポート |
| `AEDILIS_ADMIN_IDS` | 任意 | admin 操作を許す Cernere user id（カンマ区切り） |
| `AEDILIS_DATA` | 任意 | SQLite データの場所 |

> 出席チェックインを本番配線するときは、WebAuthn の RP ID / origin を
> Cernere / Ostiarius と同一 eTLD+1 に揃える必要がある。横断 env 配線は
> [`./webauthn-rp-id.md`](./webauthn-rp-id.md) を参照。

## ポート
- `17502`（LUDIARS loopback レンジ）。17500 は Dropbox squat、17501 は Bibliotheca。

## デプロイ
- 詳細・起動モードは [`../../DESIGN.md`](../../DESIGN.md) §9。
