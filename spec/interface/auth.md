# 認証・認可

## 認証（Cernere SSO）
- `/api/*` は **Cernere PASETO V4** で認証（公開鍵を fetch してローカル検証、
  [`../../server/auth.ts`](../../server/auth.ts)）。
- 必須 env: `CERNERE_BASE_URL`（鍵 fetch 先）、`AEDILIS_PUBLIC_URL`。
- 個人データは Cernere 単一情報源。Aedilis は `owner_user_id` + 表示名キャッシュ
  （`user_display_cache`）のみ保持。

## 認可
- 予約の **作成は本人**（`owner_user_id` = 認証ユーザ）。
- 予約の **変更 / キャンセル** は所有者本人 or admin。
- admin は `AEDILIS_ADMIN_IDS`（カンマ区切りの Cernere id）で判定。施設マスタ系の
  管理操作・他人予約の操作は admin。

## 関連
env は [`../setup/setup.md`](../setup/setup.md)、操作は
[`../feature/reservation.md`](../feature/reservation.md) /
[`../feature/admin.md`](../feature/admin.md)。
