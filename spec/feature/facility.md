# 施設（Facility）

## 目的
予約対象となる施設（教室・会議室等）の一覧・詳細を提供する。施設マスタは
差し替え可能な `FacilitySource` 抽象に置き、Aedilis 自身は権威にならない。

## 振る舞い
- `GET /api/facilities` — 施設一覧。`FacilitySource` から取得し `facility_cache` に
  キャッシュ。各施設は `allow_overlap`（重複予約可否）を持つ。
- `GET /api/facilities/:id` — 施設詳細。
- `POST /api/facilities/:id/overlap` — 指定時間帯の重複チェック（予約前の空き確認）。

## FacilitySource 抽象
- v0.2 は `LocalFacilitySource`（`facilities.json`）。将来は Calicula 等の外部
  マスタへ差し替え可能。Aedilis は `facility_cache` にスナップショットを持つだけ。

## 関連
データ: [`../data/schema.md`](../data/schema.md) `facility_cache`。
重複検知: [`conflict-detection.md`](conflict-detection.md)。API:
[`../interface/rest-api.md`](../interface/rest-api.md)。
