# Aedilis 仕様書

施設予約 + 予定登録/反映サービス **Aedilis**（略称 Ae）の仕様。AIFormat
[`FORMAT_SPEC.md`](https://github.com/LUDIARS/AIFormat/blob/main/FORMAT_SPEC.md)
の 6 分類に整理する。詳細設計は [`../DESIGN.md`](../DESIGN.md)。

Bibliotheca 流の単機能 Hono + SQLite + Cernere SSO。施設予約（v0.2 実装）を中核に、
Schedula / Google Calendar との双方向連携（v0.3 以降）を予定。個人データは
Cernere 単一情報源で、Aedilis は `userId` + 表示名のみ保持。

## 構成
```
spec/
├── data/        # SQLite スキーマ
├── feature/     # 機能概要（施設/予約/競合検知/admin/カレンダー連携）
├── interface/   # REST API + 認証
├── setup/       # 起動・env
└── test/        # テスト設計
```
> `plan/` は未設置（マイルストーンは [`../DESIGN.md`](../DESIGN.md) §12）。

## feature 一覧
| ドキュメント | 概要 | 状態 |
|---|---|---|
| [facility.md](feature/facility.md) | 施設一覧・詳細（FacilitySource 抽象）| v0.2 |
| [reservation.md](feature/reservation.md) | 予約 CRUD | v0.2 |
| [conflict-detection.md](feature/conflict-detection.md) | 時間帯の重複検知 | v0.2 |
| [admin.md](feature/admin.md) | admin 操作 | v0.2 |
| [calendar-sync.md](feature/calendar-sync.md) | Schedula / Google Calendar 双方向連携 | v0.3+（計画）|
