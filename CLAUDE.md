# Aedilis — Claude 向けメモ

## 性格

小さい単機能サービス。 **施設の予約台帳**に徹する。 Bibliotheca と同じ
テイスト (単一 Hono + better-sqlite3 + Cernere PASETO + esbuild SPA)。
施設の中身は持たず、 `FacilitySource` 経由で外部参照する。

## 触ってよい / よくない

- 触ってよい: `server/`, `public/`, `facilities.json`, `tsconfig*`, `package.json`, README
- 触らない: 他リポ (Cernere / Schedula 等) — Aedilis は単独完結
- DB schema 変更は CREATE IF NOT EXISTS のみ。 カラム追加は ALTER ADD COLUMN を
  後付けし、 新カラム用 INDEX は ALTER 直後に冪等発行する

## アーキ要点

- Hono + better-sqlite3 + esbuild + tsx (Bibliotheca pattern と同じ)
- Cernere PASETO V4 検証は `server/auth.ts` (公開鍵 6h 毎 refresh)
- 個人データは Cernere 単一情報源。 自前 DB には `owner_user_id` (Cernere sub) と
  display name の **キャッシュ** のみ
- 起動口は `server/bootstrap.ts`: Infisical machine identity → `ensureEnv()` で
  secret fetch & inject → `index.ts`
- 予約 ID は `crypto.randomUUID()` (DESIGN は ulid 想定だったが依存削減のため UUID)

## モジュール構成

- `server/facility/` — `FacilitySource` 抽象 + `LocalFacilitySource` (JSON)
- `server/routes/` — facilities / reservations / me
- `server/db.ts` — schema + 予約 CRUD + 重複検知 (`findConflicts`)

## v0.2 のスコープ / やらないこと

- v0.2 = 施設一覧 + 予約 CRUD + 重複検知 + 最小 SPA + admin 操作
- **やらない (v0.3 以降)**: Schedula カレンダー連携、 Google Calendar OAuth、
  予約 ↔ event の outbound/inbound sync、 承認フロー (pending→confirmed)、
  通知 (Nuntius)
- `server/calendar/` `server/sync/` は v0.3 で追加 (現状なし)

## allow_overlap の権威

施設の `allowOverlap` は JSON マスタの値で **初回 cache 投入時のみ**設定。
以後は admin のトグル (`/api/facilities/:id/overlap`) が権威。 起動同期で
上書きしない (`upsertFacilityCache` の ON CONFLICT で allow_overlap を除外)。

## テスト方針

- v0.2 は手動 (`npm run dev` → ブラウザで施設選択 → 予約 → 別アカでキャンセル)
- typecheck (`npm run typecheck`) は必ず通す
