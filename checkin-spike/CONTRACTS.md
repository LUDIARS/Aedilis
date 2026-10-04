# 出席チェックイン — 全実装の契約書 (source of truth)

4 コンポーネントを横断する I/F の正本。各リポ実装はこれに従う。Step1 スパイク
(`gateway-server.ts` / `cloud-server.ts`) を本物に昇格させたもの。

```
[PWA (Aedilis配信)] ──(LAN)──> [Ostiarius 会場ゲートウェイ] ──nonce/attestation──┐
        │                                                                         │
        │ Cernere SSO(passkey)                       Cernere passkey export ◀────┘ (初回/定期sync)
        │                                                     ▲
        └──(WAN: attestation リレー)──> [Aedilis cloud] ──webhook──> [Memoria (relay経由)]
```

## 1. Attestation (Ostiarius → PWA → Aedilis)

形式: `base64url(JSON payload) + "." + base64url(Ed25519 署名)`

```ts
interface AttestationPayload {
  sub: string;        // Cernere user id (assertion で確定した本人)
  placeId: string;    // = facilityId。出席対象の施設/部屋
  lanId: string;      // 発行ゲートウェイ ID (Aedilis が公開鍵を引くキー)
  nonce: string;      // 検証に使った challenge (base64url)。replay 検出用
  issuedAt: number;   // epoch ms。出席時刻の正本 (ゲートウェイ時計)
  method?: 'face' | 'face_passive' | 'passkey' | 'staff_override' | 'session' | 'password';
  assurance?: 'high' | 'medium' | 'manual' | 'low';
  purpose?: 'attendance' | 'mfa'; // 欠落 = 'attendance' (旧形式互換)
}
```
- 署名鍵 = ゲートウェイの永続 Ed25519 秘密鍵。
- 検証鍵 = Aedilis が `lanId` で引くゲートウェイ公開鍵 (SPKI PEM)。
- Aedilis は `placeId` が `gateway_registry[lanId].facility_id` と一致する attestation だけを受理する。
- `method` / `assurance` は payload 末尾に追加する。旧 5 フィールドのみの attestation は
  `passkey` / `medium` として受理する。
- `purpose` は末尾にさらに追加する。欠落時は `'attendance'` として従来通り受理する。
  `'attendance'` 以外 (onsite MFA 用 `'mfa'` など) の attestation は Aedilis への出席記録には
  使えず、`purpose_mismatch` (403) で拒否する ([[onsite-mfa-factor]] 契約F / browser 経路・
  kiosk 直送 `gateway-verify` 経路の両方)。
- 位置の宣言 (§6 G1、`purpose: "location"`) は同じ署名形式だが attestation ではない。
  `/api/checkin/verify` / `gateway-verify` に投げられた正規署名の宣言は `purpose_mismatch` (403) で拒否する。

## 2. Cernere — passkey 公開鍵 export (新規エンドポイント)

Ostiarius がオフライン検証するため、登録済み passkey を bulk で取得する。

`GET /api/auth/passkey/export`
- 認証: 管理者用。既存の admin 判定 or サービス用 Bearer (実装者が Cernere の流儀で決める。最低限 admin 限定)。
- query: `?project=<projectKey>` 任意 (将来の絞り込み用、無ければ全件)。
- 200 レスポンス:
```json
{ "credentials": [
  { "userId": "uuid", "credentialId": "base64url", "publicKey": "base64(COSE)", "counter": 0, "transports": ["internal"] }
]}
```
- 既存 `passkeys` テーブル (`server/src/db/schema.ts`) からそのまま射影。秘密情報は含めない (公開鍵のみ)。
- 既存の WebAuthn 実装は `server/src/http/passkey-handler.ts`。RP ID は `WEBAUTHN_RP_ID`、origin は `WEBAUTHN_ORIGINS`。**Ostiarius と PWA の origin/RPID は Cernere と同 eTLD+1 に揃える前提**を README に明記。

## 3. Ostiarius — 会場LANゲートウェイ (新規スタンドアロンサービス)

`E:\Document\Ars\Ostiarius\`。Aedilis/Bibliotheca と同型 (Hono + better-sqlite3 + tsx + esbuild不要/APIのみ)。

### config (env)
| key | 役割 |
|---|---|
| `OSTIARIUS_PORT` | listen (default 17590) |
| `OSTIARIUS_LAN_ID` | このゲートウェイの ID |
| `OSTIARIUS_FACILITY_ID` | 紐づく施設 = attestation.placeId |
| `CERNERE_BASE_URL` | passkey export の取得元 |
| `CERNERE_SERVICE_TOKEN` | export 用の admin/service Bearer |
| `OSTIARIUS_RP_ID` | WebAuthn rpID (Cernere と同 eTLD+1) |
| `OSTIARIUS_PWA_ORIGIN` | CORS 許可する PWA の origin |
| `OSTIARIUS_KEY_PATH` | Ed25519 秘密鍵の永続パス (無ければ生成して保存) |

### 動作
- 起動時 + 定期 (例 15min) に `GET {CERNERE}/api/auth/passkey/export` を取得 → ローカル sqlite `credentials` に upsert。ネット不通時は前回キャッシュで継続。
- Ed25519 鍵は `OSTIARIUS_KEY_PATH` に永続。公開鍵 PEM を起動ログに出す (運用者が Aedilis に登録する)。
- counter は best-effort (passkey は counter=0 固定が多い)。後退は warn のみ、ハード fail しない。

### API
- `POST /checkin/begin` → `generateAuthenticationOptions({ rpID, userVerification:'required', allowCredentials: synced })`。challenge を短命保存 (TTL 2min)。返り = options。
- `POST /checkin/finish` body `{ response }` → `verifyAuthenticationResponse` (synced 公開鍵で) → OK なら `sub` を credentialId→userId で引き、attestation 署名して返す `{ ok, attestation }`。
- `GET /gateway-public-key` → `{ lanId, facilityId, publicKeyPem }` (初回 provision 用)。
- 全 API に CORS (`OSTIARIUS_PWA_ORIGIN`)。

## 4. Aedilis — check-in 内包 (既存リポに追加)

### DB (server/db.ts に CREATE IF NOT EXISTS 追加)
```sql
CREATE TABLE IF NOT EXISTS gateway_registry (
  lan_id        TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  facility_id   TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  id            TEXT PRIMARY KEY,         -- randomUUID
  user_id       TEXT NOT NULL,            -- Cernere sub
  facility_id   TEXT NOT NULL,
  lan_id        TEXT NOT NULL,
  checked_in_at INTEGER NOT NULL,         -- = attestation.issuedAt
  reservation_id TEXT,                    -- 照合できた予約 (なければ null = walk-in)
  nonce         TEXT NOT NULL,            -- replay 防止
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_nonce ON attendance(nonce);
CREATE INDEX IF NOT EXISTS attendance_user ON attendance(user_id, checked_in_at);
```

### API (`server/routes/checkin.ts`, `/api/checkin`)
- `POST /api/checkin/verify` (requireAuth) body `{ attestation }`:
  1. payload を decode、`gateway_registry[lanId]` の公開鍵で署名検証。無ければ 400。
  2. **本人性**: `payload.sub === auth.userId` を必須 (他人の attestation を投げさせない)。
  3. **鮮度**: `now - issuedAt <= 120_000ms` を必須 (古い attestation 拒否)。
  4. **replay**: `nonce` を attendance に UNIQUE 挿入。重複なら 409。
  5. **予約照合**: 同 `userId` × `facilityId` で `checked_in_at` を含む confirmed reservation を検索 → あれば `reservation_id` 紐付け。無ければ walk-in (reservation_id=null)。
  6. attendance 記録 → Memoria webhook を fire-and-forget (§5) → `{ ok, attendanceId, matchedReservation }`。
- `GET /api/checkin/mine` (requireAuth) → 自分の出席一覧。
- `POST /api/checkin/gateway-verify` body `{ attestation }` → Ostiarius kiosk が直接送信する経路。
  `Authorization: Bearer <gateway token>` と、その token に紐付く gateway の署名を必須とする。
- `POST /api/checkin/events-summary` body `{ counts: Record<string, number> }` → 同じ gateway token で
  Ostiarius outbox の件数のみを保存する。
- `GET /api/checkin?facility=&from=&to=` (requireAdmin) → 出席一覧と staff override 件数・passkey 連続利用注意。
- `POST /api/admin/gateways` (requireAdmin) body `{ lanId, publicKeyPem, facilityId, label? }` → gateway_registry upsert。
  応答の `gatewayToken` は登録時だけ返し、以後はハッシュのみを保存する。
- `GET /api/admin/gateways` (requireAdmin) → 一覧。

### PWA (`public/` に check-in 画面)
- Cernere SSO (既存 `@ludiars/cernere-composite` パターン or 既存 public/src のログイン踏襲)。
- 設定: 接続するゲートウェイ URL (会場の LAN アドレス)。`AEDILIS_DEFAULT_GATEWAY_URL` を `/api/health` 等で配るか、画面で入力/QR。Step では設定欄でよい。
- フロー: `POST {gateway}/checkin/begin` → `startAuthentication` → `POST {gateway}/checkin/finish` → `POST /api/checkin/verify {attestation}` (Aedilis、Cernere Bearer 付き) → 結果表示。
- vanilla TS + esbuild (既存 `public/src/app.ts` と同じ build:web)。

### env 追加
- `MEMORIA_WEBHOOK_URL` (任意。未設定なら webhook を送らない)。

## 5. Memoria — 出席イベント受信 (relay 経由が正)

- Aedilis → `POST {MEMORIA_WEBHOOK_URL}` body:
```json
{ "type": "attendance.checked_in", "userId": "uuid", "facilityId": "room-101",
  "checkedInAt": 1718000000000, "reservationId": "uuid|null", "source": "aedilis" }
```
- Memoria は online 直接 write 不可 ([[feedback_memoria_online_flow]]) なので **Imperativus relay 経由**が正。実装者は Memoria の relay 受け口に「presence/attendance ログ」として1件追加する形にする。直接 write になる場合は relay 経由に寄せ、難しければ受信スタブ + TODO を残す。
- 個人データは userId アンカーのみ ([[project_personal_data_rule]])。

## 6. GPS + 写真チェックイン (Ostiarius / GLAB / Aedilis 共通契約)

neco の決定 (2026-10-04)。スマホは GPS のチェックイン型。スマホの GPS が Ostiarius の返す会場位置と
一致しているかで判定し、添付写真の Exif 日時と SHA-256 で使い回しを弾く。GPS の出席は
`method="gps"`・`assurance="low"` で出席に数える。名前・パス・エラーコードは 3 リポで同じ文面を保つ。

### G1. 位置の宣言 (Ostiarius)
- 設定: `OSTIARIUS_FACILITY_LAT` / `OSTIARIUS_FACILITY_LON` (10 進度) / `OSTIARIUS_FACILITY_RADIUS_M` (整数 m)。
  3 つ揃わなければ宣言を出さない (GPS チェックイン不可)。
- 宣言 = §1 と同じ形式 `base64url(JSON payload) + "." + base64url(Ed25519 署名)`、gateway 鍵で署名。
  payload のキー順は固定: `{ lanId, facilityId, lat, lon, radiusM, issuedAt, purpose: "location" }` (issuedAt は epoch ms)。
- 公開: `/api/health` の応答に `locationStatement` (無ければ省略)。別途 `GET /api/location` → `{ locationStatement }`。
- purpose `"location"` は出席・MFA の attestation として受理されない (Aedilis / Cernere とも `purpose_mismatch`)。

### G2. スマホ → GLAB
- GLAB (HTTPS) の「GPS で出席」: `navigator.geolocation.getCurrentPosition` (enableHighAccuracy) で
  `{ lat, lon, accuracyM, positionAt }`、`<input type="file" accept="image/*" capture="environment">` で写真 1 枚。
- `POST` GLAB attendance plugin `/checkin/gps` (multipart、ユーザ認証必須)。GLAB は Ostiarius の health probe で
  得た最新の `locationStatement` を付けてユーザの token のまま Aedilis へ中継する。写真は保存・ログ出力しない。

### G3. GLAB → Aedilis (`POST /api/checkin/gps`)
- ユーザの Cernere token (sub がチェックイン本人)。multipart/form-data: fields `locationStatement` `lat` `lon`
  `accuracyM` `positionAt` (epoch ms の数値文字列、ISO 8601 も可) と file `photo` (`image/jpeg` / `image/heic`、10 MB 以下)。
- 200 `{ ok: true, attendanceId }` / 4xx `{ error: <code> }`。code は固定語彙:

| code | HTTP | 段階 |
|---|---|---|
| `invalid_input` | 400 | 1 (形式) / 4 (positionAt がサーバ時刻 ±5 分の外) |
| `photo_invalid` | 400 (body 上限超過は 413) | 1 (型・マジックバイト・10 MB) |
| `statement_invalid` | 400 | 2 (形式・署名・purpose != "location") |
| `unknown_gateway` | 400 | 2 (lanId 未登録) |
| `facility_mismatch` | 403 | 2 (facilityId != gateway 登録施設) |
| `statement_stale` | 400 | 3 (issuedAt がサーバ時刻 ±15 分の外) |
| `accuracy_too_low` | 400 | 4 (accuracyM > 100) |
| `out_of_range` | 403 | 4 (haversine 距離 > radiusM + accuracyM) |
| `exif_missing` | 400 | 5 (DateTimeOriginal なし) |
| `exif_time_out_of_window` | 400 | 5 (撮影時刻がサーバ時刻 ±10 分の外) |
| `exif_location_out_of_range` | 403 | 5 (Exif GPS があり、4 と同じ範囲判定で外) |
| `photo_reused` | 409 | 6 (SHA-256 既出、または同一利用者 × 同一 DateTimeOriginal 既出) |
| `rate_limited` | 429 | 利用者単位 1 分 5 回 (検証より前に判定) |

- 検証はこの順: 1 入力形式 → 2 宣言の署名・purpose・施設 → 3 鮮度 → 4 位置 → 5 Exif → 6 使い回し → 7 記録。
- Exif の撮影時刻は `DateTimeOriginal` に `OffsetTimeOriginal` を適用し、無ければ施設のタイムゾーン Asia/Tokyo (+09:00) とみなす。
- 記録: attendance に `method="gps"`・`assurance="low"`、`checked_in_at` = サーバ受理時刻、`lan_id` = 宣言の lanId、
  `nonce` = `gps:<sha256>`。予約照合・walk-in・Memoria webhook は §4 と同じ流れ。同日同施設の重複は §4 と同じく制限しない。
  `CHECKIN_MIN_ASSURANCE` は attestation 経路だけに効き、GPS 経路の low は拒否しない (neco 決定で出席に数える)。
- 保存: `gps_checkin_photo` に SHA-256・Exif 撮影時刻・判定結果・距離 (m) だけ。写真本体と Exif の位置は保存しない。

```sql
CREATE TABLE IF NOT EXISTS gps_checkin_photo (
  photo_sha256  TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  exif_taken_at INTEGER NOT NULL,   -- epoch ms
  result        TEXT NOT NULL,      -- 'accepted'
  distance_m    REAL NOT NULL,
  attendance_id TEXT,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS gps_checkin_photo_user_taken ON gps_checkin_photo(user_id, exif_taken_at);
```

## 共通方針
- 各リポ feat ブランチ (`feat/checkin-*`)、マージしない (投機実装)。
- typecheck / build は緑にする。
- secret/鍵は平文保存しない方針 ([[feedback_config_and_secrets]])。Ostiarius の Ed25519 秘密鍵はファイル権限で保護 (スパイク段階は平文ファイル可、README に注記)。
