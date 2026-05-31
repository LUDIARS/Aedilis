# 予約（Reservation）

## 目的
施設に対する時間帯予約を作成・変更・取消する。誰が・どの施設を・いつ使うかを
記録し、重複を防ぐ。

## 振る舞い
- `GET /api/reservations` — 予約一覧（施設 / 期間で絞り）。
- `GET /api/reservations/mine` — 自分の予約。
- `POST /api/reservations` — 予約作成。`facility_id` + `start_at`/`end_at`（epoch ms）
  + `purpose`。**重複検知**を通過すれば `state=confirmed` で確定。
- `PATCH /api/reservations/:id` — 時間/用途の変更。変更後に重複を再検知。
- `DELETE /api/reservations/:id` — キャンセル（`state=cancelled`。物理削除しない）。

## 認可
- 作成は本人（`owner_user_id` = 認証ユーザ）。変更/取消は所有者本人 or admin
  （[`../interface/auth.md`](../interface/auth.md)）。

## 制約・前提
- 時刻は epoch ms。`cancelled` は重複検知の対象外。
- 個人データは持たず、所有者は Cernere id + 表示名キャッシュ。

## 関連
データ: [`../data/schema.md`](../data/schema.md) `reservation`。
重複: [`conflict-detection.md`](conflict-detection.md)。
