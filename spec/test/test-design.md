# テスト設計

ランナーは **vitest**（`npm test`）。方針は AIFormat
[`RULE_TEST.md`](https://github.com/LUDIARS/AIFormat/blob/main/RULE_TEST.md)。
Aedilis は **Web サービス（予約）** 種別。重視点は予約の重複検知（境界）と
認可境界（作成=本人 / 変更削除=所有者|admin、未認証で破壊操作不可）。

## 現状（実装済テスト）
| ファイル | カバー |
|---|---|
| [`../../test/db.test.ts`](../../test/db.test.ts) | DB CRUD・重複検知（in-memory SQLite） |
| [`../../test/facility-source.test.ts`](../../test/facility-source.test.ts) | FacilitySource（ローカル JSON）の解決 |
| [`../../test/routes.test.ts`](../../test/routes.test.ts) | ルートの認可（auth 経路） |

CI（`.github/workflows/test.yml`）で typecheck + build:web + test を実行。

## 種別ごとの観点（充実とみなす対象）
### ユニット（DB / 純ロジック）
- [x] 予約作成 → 同一施設・重複時間帯の拒否（`reservation_facility_time`、cancelled 除外）。
- [x] `allow_overlap=1` 施設では重複を許す。
- [x] FacilitySource のキャッシュ解決。

### 統合（REST + 認可）
- [x] 未認証で全 API 401（`routes.test.ts`）。
- [ ] 他人の予約を PATCH/DELETE できない（所有者|admin 境界）の網羅。
- [ ] `POST /facilities/:id/overlap` の空き判定境界（端点 start==end 等）。

### smoke
- [ ] 起動 + `/api/health` + 未認証で保護ルート 401。

## やること（gap）
- [ ] calendar-sync（v0.3）実装時に、Outbound/Inbound の冪等・重複反映防止テスト。
