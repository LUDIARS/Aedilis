# REST API

Hono。全 `/api/*` は Cernere PASETO 検証（[`auth.md`](auth.md)）。マウントは
[`../../server/index.ts`](../../server/index.ts)。SPA は `public/` を serve。

## ヘルス / 宣言
| Method | Path | 動作 |
|---|---|---|
| GET | `/api/health` | ヘルス |
| GET | `/.well-known/ludiars-app.json`（corpus manifest path） | Corpus 宣言マニフェスト |
| GET | `/api/me` | 認証ユーザの id / 表示名 / admin 判定 |

## facilities（`/api/facilities`）
| Method | Path | 動作 |
|---|---|---|
| GET | `/` | 施設一覧（`facility_cache` / FacilitySource） |
| GET | `/:id` | 施設詳細 |
| POST | `/:id/overlap` | 指定時間帯の重複チェック（予約前の空き確認） |

## reservations（`/api/reservations`）
| Method | Path | 動作 |
|---|---|---|
| GET | `/` | 予約一覧（施設/期間で絞り） |
| GET | `/mine` | 自分の予約 |
| POST | `/` | 予約作成（重複検知 → confirmed） |
| PATCH | `/:id` | 予約変更（時間/用途）。重複再検知 |
| DELETE | `/:id` | 予約キャンセル（state=cancelled）|

> 認可: 予約の変更/削除は所有者 or admin。詳細は [`auth.md`](auth.md) /
> [`../feature/reservation.md`](../feature/reservation.md)。

## 宣言的レンダリング
Corpus 流の declarative UI（`server/corpus.ts` の panel 宣言）を返す経路あり。
フロントは Corpus renderer 流用で描画。
