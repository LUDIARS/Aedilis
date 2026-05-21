# Aedilis — 設計書 (draft v0.1)

> 名の由来: 古代ローマの **aedilis** (アエディリス) — 公共建物・市場・公式祭礼カレンダーを統括した官職。 「施設管理 + 行事スケジュール」 が職務そのままなので、 本サービスの二本柱と完全一致する。

LUDIARS の **施設予約サービス**。 同時に「予定の登録/反映」 を担い、 Schedula / Google Calendar と双方向連携する。 Bibliotheca と同じテイストの小さい単機能 Hono サービスとして立ち上げる。

> カレンダー連携先について: LUDIARS の予定管理は 2026-05-20 に Actio から **Schedula** ([[../Schedula/DESIGN.md]]) として再分離された。 Actio は「タスク管理」 専用になるため、 Aedilis のカレンダー連携先は **Schedula** (予定基盤) であって Actio ではない。

短縮コード案: **Ae** (PROJECT-CODES.md への登録は実装フェーズで)
リポ: `E:\Document\Ars\Aedilis\` (LUDIARS push 未)
親目標: [2026年5月集中目標 2](../../../../Users/raury/.claude/projects/E--Document-Ars/memory/project_2026_05_goals.md)

---

## 1. 目的とスコープ

### 1.1 目的

- 施設 (会議室・備品付きスペース・体育館・実験室 等) の **予約台帳** を一本化する
- 予約と同時に **カレンダー予定** を登録 → Schedula / Google Calendar に反映する
- 逆向きに、 Schedula / Google Calendar 上で作った予定から施設を押さえることも可能にする

### 1.2 スコープ内

- 予約 CRUD (作成 / 一覧 / キャンセル)
- 施設マスタ参照 (中身は持たない、 外部 source 経由)
- 予定の Schedula / Google Calendar 同期 (双方向)
- 競合検知 (同一施設 × 時間帯重複は拒否)
- Cernere SSO + admin 操作

### 1.3 スコープ外 (v0.1)

- 施設マスタ管理 UI (外部マスタを参照するのみ)
- 機材貸出 (= Bibliotheca の領分)
- カリキュラム編集 (= Calicula の領分)
- 課金 / 支払 (= Quaestor の領分が将来あれば連携)
- 通知配信 (= Nuntius が将来連携、 v0.1 ではプッシュしない)

---

## 2. 既存サービスとの境界

| サービス | 関係 |
|---|---|
| **Schedula** | カレンダー / 予定基盤。 Aedilis は Schedula に予定を push、 Schedula からの予定変更を pull する。 Schedula の `/api/events` を `CalendarProvider` の `schedula` 実装で叩く ([[../Schedula/DESIGN.md]] §3)。 |
| **Actio** | タスク管理サービス。 Aedilis は **直接は連携しない**。 旧構成では Actio がカレンダーも持っていたが 2026-05-20 に予定軸が Schedula へ分離。 Actio の途中実装 `modules/reservation` は破棄。 |
| **Calicula** | カリキュラム予定。 Calicula から「この時間 この施設」 と要求が来たら Aedilis が押さえる。 旧メモ「施設予約データ形式の権威は Actio」 は撤回、 Aedilis が権威。 |
| **Bibliotheca** | 構造の手本。 認証・bootstrap・MasterSource パターンを踏襲。 |
| **Cernere** | 認証。 PASETO V4、 admin 判定は `AEDILIS_ADMIN_IDS`。 |
| **Nuntius** | v0.2 以降に「予約確定/キャンセル/前日リマインド」 配信を委譲予定。 v0.1 では結線しない。 |
| **Google Calendar** | 外部カレンダー。 OAuth2 で個人カレンダーに event を作成/更新。 |

---

## 3. 機能要件

### 3.1 施設 (Facility)

- 施設の中身 (名前/場所/定員/備品) は **Aedilis が直接保持しない**
- `FacilitySource` interface で外部参照する (Bibliotheca の `MasterSource` と同型パターン)
- v0.1 では `LocalFacilitySource` (JSON ファイル) を暫定実装
- 後で Cernere / Schedula (school 系の施設データ) / 専用マスタ DB ができたら差替

### 3.2 予約 (Reservation)

- 1 予約 = `(facilityId, startAt, endAt, ownerUserId, purpose)`
- 作成時に重複チェック (同 facility × 時間帯)
- キャンセル: 本人 or admin
- 状態: `pending` / `confirmed` / `cancelled`
  - v0.1 は登録即 `confirmed` (承認フローは v0.2 で `pending → confirmed`)

### 3.3 予定連携 (Calendar Sync)

ユーザ単位で 0..N 個の **CalendarBinding** を持つ:

- `schedula`: Schedula 内のカレンダー (1 ユーザ 1 本前提)
- `google`: Google Calendar (OAuth2、 複数本可)

Aedilis 予約 1 件 ← → カレンダー event N 件 を `ExternalEventLink` テーブルで紐付け管理する。

#### 3.3.1 outbound (Aedilis → Schedula/Google)

- 予約 confirm 時に bind 済の全カレンダーへ event push
- 予約 cancel 時に対応 event を削除
- 予約の時間/施設/目的変更時に event を patch

#### 3.3.2 inbound (Schedula/Google → Aedilis)

- Schedula webhook (将来) / Google Calendar push notification を受信
- event に `aedilis:<reservationId>` の extendedProperty があれば自分が作った event なので無視
- それ以外で「施設を持つ」 event なら、 該当施設の空き判定をして 予約レコード生成 or 競合通知

inbound は **v0.1 では Schedula 側のみ** (Google からの inbound は v0.2 以降)。

### 3.4 競合検知

- 同 facility × 時間帯重複 → 409 で拒否
- 重複しても問題ない facility (= 「重複可」 フラグ付き) は許可
- 競合の検知単位は 1 分 (秒は切捨て)

### 3.5 admin 操作

- 任意ユーザの予約の代理キャンセル
- 「重複可」 フラグの切替
- カレンダー link の手動 unlink
- 信頼源は `AEDILIS_ADMIN_IDS` env (Bibliotheca と同パターン)

---

## 4. 非機能要件

- **個人データ**: Cernere 単一情報源。 Aedilis は `userId` (Cernere sub) と display name キャッシュのみ保持
- **OAuth トークン**: Google refresh token は **Infisical 経由で別 secret 化**、 SQLite には access token の短期キャッシュのみ
- **ポート**: loopback `17502` (Bibliotheca = 17501、 隣で取る。 17500 は Dropbox squat なので避ける)
- **データベース**: SQLite (better-sqlite3 / WAL)、 ファイル `data/aedilis.db`
- **可用性**: 単一プロセス、 落ちたら再起動 (Excubitor 経由運用)
- **同時編集**: pessimistic lock は持たない。 重複検知で十分

---

## 5. アーキテクチャ

```
┌─────────────────────────────────────┐
│ Browser (vanilla TS + ZXing 等)     │  ← Bibliotheca 流
└──────────────┬──────────────────────┘
               │ REST + SSE
┌──────────────▼──────────────────────┐
│ Hono server (single process)        │
│  ├─ auth.ts      (Cernere PASETO)   │
│  ├─ routes/                         │
│  │   ├─ facilities.ts               │
│  │   ├─ reservations.ts             │
│  │   └─ calendars.ts                │
│  ├─ facility/source.ts (interface)  │
│  │   └─ LocalFacilitySource         │
│  ├─ calendar/                       │
│  │   ├─ provider.ts (interface)     │
│  │   ├─ schedula.ts                 │
│  │   └─ google.ts                   │
│  ├─ sync/                           │
│  │   ├─ outbound.ts                 │
│  │   └─ inbound.ts                  │
│  └─ db.ts (better-sqlite3)          │
└──────────────┬──────────────────────┘
               │
       ┌───────┴──────┐
       ▼              ▼
   Cernere      Schedula / Google
   (authz)      Calendar (events)
```

### 5.1 ディレクトリ構成 (案)

```
Aedilis/
├── CLAUDE.md            # Claude 向け内部メモ
├── README.md            # ユーザ向け
├── DESIGN.md            # 本書
├── env-cli.config.ts    # Infisical secret 一覧
├── data/                # SQLite + facility JSON 暫定マスタ
├── public/              # ビルド前 SPA
├── server/
│   ├── bootstrap.ts     # Infisical bootstrap → index.ts
│   ├── index.ts         # Hono app 起動
│   ├── auth.ts          # PASETO V4 検証 + requireAdmin
│   ├── db.ts            # better-sqlite3 + migrations
│   ├── facility/
│   │   ├── source.ts
│   │   └── local.ts
│   ├── calendar/
│   │   ├── provider.ts
│   │   ├── schedula.ts
│   │   └── google.ts
│   ├── sync/
│   │   ├── outbound.ts
│   │   └── inbound.ts
│   └── routes/
│       ├── facilities.ts
│       ├── reservations.ts
│       └── calendars.ts
├── package.json
├── tsconfig.json
└── tsconfig.frontend.json
```

---

## 6. データスキーマ (SQLite, v0.1)

```sql
-- 施設のキャッシュ (中身は外部 source が権威、 これは検索高速化のためのスナップショット)
CREATE TABLE IF NOT EXISTS facility_cache (
  facility_id     TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  source          TEXT NOT NULL,    -- 'local' / 'schedula' / ...
  allow_overlap   INTEGER NOT NULL DEFAULT 0,
  raw_json        TEXT NOT NULL,    -- 元データを丸ごと保存
  fetched_at      INTEGER NOT NULL  -- epoch ms
);

CREATE TABLE IF NOT EXISTS reservation (
  id              TEXT PRIMARY KEY,        -- ulid
  facility_id     TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,           -- Cernere sub
  start_at        INTEGER NOT NULL,        -- epoch ms (1 分丸め)
  end_at          INTEGER NOT NULL,
  purpose         TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT 'confirmed',  -- 'pending'|'confirmed'|'cancelled'
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reservation_facility_time
  ON reservation(facility_id, start_at, end_at)
  WHERE state != 'cancelled';
CREATE INDEX IF NOT EXISTS reservation_owner
  ON reservation(owner_user_id);

-- 個人ごとの calendar binding
CREATE TABLE IF NOT EXISTS calendar_binding (
  id              TEXT PRIMARY KEY,        -- ulid
  user_id         TEXT NOT NULL,           -- Cernere sub
  provider        TEXT NOT NULL,           -- 'schedula'|'google'
  external_id     TEXT NOT NULL,           -- google calendarId / schedula calendarId
  display_name    TEXT NOT NULL,
  token_ref       TEXT,                    -- Infisical key (google のみ)
  created_at      INTEGER NOT NULL,
  UNIQUE(user_id, provider, external_id)
);

-- 予約 ←→ 外部 event の対応 (1:N)
CREATE TABLE IF NOT EXISTS external_event_link (
  reservation_id  TEXT NOT NULL,
  binding_id      TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  etag            TEXT,
  PRIMARY KEY (reservation_id, binding_id)
);

-- userId → display name キャッシュ
CREATE TABLE IF NOT EXISTS user_display_cache (
  user_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

migration は CREATE IF NOT EXISTS のみ。 カラム追加は ALTER 系を後付け [[feedback_sqlite_create_index_after_alter]] パターンで足す。

---

## 7. API (v0.1)

すべて `/api/*`、 Cernere PASETO Bearer 必須。

| Method | Path | 役割 |
|---|---|---|
| GET  | `/api/facilities`                       | 施設一覧 (FacilitySource から fetch + cache) |
| GET  | `/api/facilities/:id`                   | 施設詳細 |
| GET  | `/api/reservations?facility=&from=&to=` | 予約一覧 (期間 + 施設 filter) |
| GET  | `/api/reservations/mine`                | 自分の予約一覧 |
| POST | `/api/reservations`                     | 新規予約 (重複検知 → confirmed) |
| PATCH| `/api/reservations/:id`                 | 時刻/目的の修正 (本人のみ) |
| DELETE| `/api/reservations/:id`                | キャンセル (本人 or admin) |
| GET  | `/api/calendars`                        | 自分の binding 一覧 |
| POST | `/api/calendars/google/connect`         | Google OAuth 開始 (redirect URL 返却) |
| GET  | `/api/calendars/google/callback`        | Google OAuth callback (refresh token 取得 → Infisical) |
| DELETE| `/api/calendars/:id`                   | binding 削除 + link 解除 |
| POST | `/api/admin/facilities/:id/overlap`     | admin: allow_overlap 切替 |

エラー形式は `{ "error": "string", "code": "RESERVATION_CONFLICT" }` を統一。

---

## 8. Calendar Sync の詳細

### 8.1 Outbound

予約 confirm / patch / cancel のたびに `sync/outbound.ts` に enqueue:

```ts
type OutboundJob =
  | { kind: 'create'; reservationId: string }
  | { kind: 'update'; reservationId: string }
  | { kind: 'delete'; reservationId: string };
```

worker は予約の owner の全 binding を fetch、 provider ごとに event push/patch/delete。 成功時 `external_event_link` を upsert。 失敗時はリトライ (指数バックオフ 1m / 5m / 30m、 3 回で諦め)。

event の extendedProperty に必ず `aedilis:<reservationId>` を書く (inbound 重複防止)。

### 8.2 Inbound (v0.1 は Schedula のみ)

Schedula webhook (将来仕様) を `/api/sync/schedula/webhook` で受信。 event の properties を見て:

1. `aedilis:*` ありなら自分の outbound 起源 → 無視
2. それ以外で `location` に施設 ID と解釈可能な文字列があれば、 該当施設の予約を試みる
3. 重複 → 競合通知 (v0.1 では サーバログ + Schedula に reply event を返すだけ)

Google Calendar からの inbound は v0.2 以降。 push notification 受信に Google Cloud Console と HTTPS endpoint が要るため、 Cernere/infra と相談してから着手。

---

## 9. 起動とデプロイ

### 9.1 起動モード (Bibliotheca と同型)

- **Mode A**: ローカル `.env` 直
- **Mode B**: Infisical (env-cli) — 推奨
- **Mode C**: Excubitor → child process に INFISICAL_* inject

`server/bootstrap.ts`:

1. `.env.secrets` (INFISICAL_*) + `.env` を読む
2. `ensureEnv()` で Infisical から fetch + inject (existing は上書きしない)
3. `index.ts` を import

### 9.2 必須 env

| Key | 役割 |
|---|---|
| `CERNERE_BASE_URL` | Cernere の公開鍵 fetch 用 |
| `AEDILIS_ADMIN_IDS` | カンマ区切り Cernere sub |
| `SCHEDULA_BASE_URL` | Schedula (予定基盤) の API ベース |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Google Calendar OAuth |
| `AEDILIS_PUBLIC_URL` | OAuth callback URL の組立用 |

Google `refresh_token` は user × binding ごとに `AEDILIS_GOOGLE_REFRESH_<bindingId>` という名前で **Infisical に書き戻す** (process memory には access token の短期キャッシュのみ持つ — [[feedback_secret_per_user_memory_only]] と同方針)。

### 9.3 ポート

loopback **17502** を予約。 17500 (Dropbox) / 17501 (Bibliotheca) と衝突しない隣。 `infra/PORT-MAP.md` への登録は実装 PR で同時に。

---

## 10. セキュリティ / 個人データ

- 個人データは Cernere 単一情報源 ([[project_personal_data_rule]])
- Aedilis に保存するユーザ識別子は Cernere `sub` (= ULID 相当) のみ
- display name はキャッシュ目的でのみ保持、 Cernere 側更新で 24h TTL refresh
- Google refresh token は SQLite には**書かない**、 Infisical secret に書く
- 予約の `purpose` は自由記入 → ログに dump しない、 API レスポンスでも他人には返さない

---

## 11. やる / やらないリスト

### やる (v0.1)

- 単一 Hono server + SQLite + Cernere SSO
- 施設一覧 / 予約 CRUD / 重複検知
- Schedula への outbound sync
- Google Calendar への outbound sync (OAuth + event create/update/delete)
- admin: 重複可フラグ切替、 代理キャンセル
- 最小 SPA (vanilla TS、 Bibliotheca 流の esbuild build)
- Infisical bootstrap 3 モード対応

### やらない (v0.1)

- 施設マスタの編集 UI (Local JSON 直編集で済ます)
- 通知配信 (v0.2 で Nuntius 連携)
- 承認フロー (`pending → confirmed`)
- Google Calendar からの inbound sync
- 課金 / 利用統計
- モバイル native アプリ (PWA で十分)

---

## 12. マイルストーン

| 版 | 内容 |
|---|---|
| **v0.0 (本書)** | DESIGN.md 起草、 memory & 5月目標更新 |
| **v0.1 scaffold** | `package.json` / `server/` / `public/` の骨格 + Cernere 認証 + `/api/health` |
| **v0.2 core** | 予約 CRUD + 重複検知 + Local facility source + 最小 SPA |
| **v0.3 schedula-sync** | Schedula outbound + (将来 inbound 用の) webhook 受信口 |
| **v0.4 google-sync** | Google OAuth + outbound (refresh token を Infisical 書込) |
| **v0.5 admin + polish** | admin route + 表示細部 + Excubitor 登録 + README |
| **v1.0** | Hub 上で施設予約が「できる」 状態 (5月目標 2 達成) |

5月内 (~05-31) は v0.5 まで進めば「動く」 と言える状態。 残 11 日。

---

## 13. オープン論点 (要決定)

1. ~~**サービス名**~~ → **Aedilis** で確定 (2026-05-20)。 古代ローマの aedile (公共施設 + 公式祭事 = カレンダー の管理官) と意味的に一致
2. ~~**短縮コード**~~ → **Ae** で確定 (2026-05-20)、 衝突なし。 予備 Al
3. **Calicula との関係** — 旧メモの「施設予約は Actio 権威」 は撤回するが、 Calicula → Aedilis へ予約要求を流すフローは要設計
4. ~~**Actio modules/reservation の途中実装の扱い**~~ → 完全破棄で確定 (2026-05-20)。 移行 script は不要 (古いデータなし前提)
5. **Schedula 連結のタイミング** — Aedilis の `schedula` provider は Schedula 本体の `/api/events` が立ってから結線。 Schedula 移植 ([[../Schedula/DESIGN.md]] §6) の P1-P2 完了が前提。 v0.3 着手前に Schedula の event API 稼働を確認する
6. **Hub 上の見え方** — Memoria Hub Shell で Aedilis をどの単位 (タブ/ペイン) で出すか
7. **「公共行事」 機能の取り扱い** — Aedilis 語源は公共祭礼を含む。 v0.5 までは「個人/小集団の施設予約」 に絞り、 行事公開機能 (公開イベント告知) は v1.x で別途検討
