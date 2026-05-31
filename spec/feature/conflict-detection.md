# 競合検知（重複予約防止）

## 目的
同一施設の同じ時間帯に複数予約が入らないようにする（`allow_overlap` の施設を除く）。

## 振る舞い
- 予約の作成 / 変更時に、対象施設の既存予約（`state != 'cancelled'`）と時間帯が
  重なるかを判定。重なれば拒否する。
- インデックス `reservation_facility_time (facility_id, start_at, end_at)
  WHERE state != 'cancelled'` を用いて効率的に検索。
- 施設の `allow_overlap=1` の場合は重複を許可（複数同時利用可の施設）。
- `POST /api/facilities/:id/overlap` で予約前に空き確認できる。

## 境界・注意
- 区間の重なり判定は半開区間（`start < other.end && end > other.start`）を想定。
  端点一致（`end == other.start`）は重複としない。
- キャンセル済（`cancelled`）は判定から除外。

## 関連
[`reservation.md`](reservation.md) / [`../data/schema.md`](../data/schema.md)。
テスト観点は [`../test/test-design.md`](../test/test-design.md)。
