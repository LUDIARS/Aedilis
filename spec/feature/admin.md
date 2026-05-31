# admin 操作

## 目的
管理者が施設マスタの管理や他人予約の調整など、一般ユーザに許さない操作を行う。

## 振る舞い
- admin は `AEDILIS_ADMIN_IDS`（カンマ区切りの Cernere user id）で判定。
- admin が可能なこと（v0.2 / 設計 [`../../DESIGN.md`](../../DESIGN.md) §3.5）:
  - 他ユーザの予約の変更 / キャンセル（通常は所有者本人のみ）。
  - 施設マスタ（FacilitySource）に関わる管理・再取得。
- 一般ユーザは自分の予約のみ操作可。

## 関連
認可の詳細は [`../interface/auth.md`](../interface/auth.md)。env は
[`../setup/setup.md`](../setup/setup.md)。
