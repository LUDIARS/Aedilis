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
}
```
- 署名鍵 = ゲートウェイの永続 Ed25519 秘密鍵。
- 検証鍵 = Aedilis が `lanId` で引くゲートウェイ公開鍵 (SPKI PEM)。

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
- `GET /api/checkin?facility=&from=&to=` (requireAdmin) → 出席一覧。
- `POST /api/admin/gateways` (requireAdmin) body `{ lanId, publicKeyPem, facilityId, label? }` → gateway_registry upsert。
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

## 共通方針
- 各リポ feat ブランチ (`feat/checkin-*`)、マージしない (投機実装)。
- typecheck / build は緑にする。
- secret/鍵は平文保存しない方針 ([[feedback_config_and_secrets]])。Ostiarius の Ed25519 秘密鍵はファイル権限で保護 (スパイク段階は平文ファイル可、README に注記)。
