# WebAuthn の RP ID / origin を eTLD+1 で統一するための設定

出席チェックイン (Cernere 登録 → Ostiarius 検証 → Aedilis 記録) を本番で
成立させるための **横断 env 配線ガイド**。 用途別セットアップ
([[feedback_setup_guides_spec_setup]] の「○○するための設定」テンプレ、サービス系)
に従い、 3 サービスの WebAuthn 関連 env を 1 か所にまとめる。

対象サービス: **Cernere** (passkey 登録) / **Ostiarius** (会場ゲートウェイ、
assertion 検証) / **Aedilis** (PWA 配信 + 出席記録)。

---

## 1. なぜ統一が要るか

WebAuthn は **RP ID (Relying Party ID)** と **origin** を仕様レベルで縛る。

- **RP ID は eTLD+1 か、その下位サブドメインでなければならない。**
  ブラウザは passkey assertion を生成するとき、現在の `window.location.hostname`
  が指定された RP ID と「同一、または RP ID のサブドメイン」であることを検証する。
  例: ページが `checkin.example.com` なら RP ID に使えるのは
  `checkin.example.com` または `example.com`。 `auth.example.com` や
  `other.com` は **使えない** (別サブドメイン/別ドメインは拒否)。
- **検証側 (Ostiarius) の `expectedRPID` は、登録時 (Cernere) の RP ID と
  バイト一致していなければならない。** assertion の `authenticatorData` には
  RP ID の SHA-256 (`rpIdHash`) が埋まっており、検証側はこれを
  `SHA-256(expectedRPID)` と突合する。1 文字でも違えば assertion は失敗する。
- **origin も一致が要る。** `clientDataJSON.origin` (passkey を作った PWA の
  origin) が検証側の `expectedOrigin` と一致しなければならない。https 必須
  (localhost を除く)。

→ **結論**: Cernere の `WEBAUTHN_RP_ID`、Ostiarius の `OSTIARIUS_RP_ID` を
**完全に同じ eTLD+1 文字列**にし、passkey を作る PWA (Aedilis 配信) の origin を
両者の origin 許可リストに含める。これを外すと本番で全チェックインが
`assertion_failed` になる ― 本番配線の最大の落とし穴。

---

## 2. 各サービスの該当 env キー

実装から実在確認した正確なキー名と参照箇所 (path:line)。

### Cernere — passkey 登録 / assertion 検証 (一次)

| env | 既定 | 用途 |
|---|---|---|
| `WEBAUTHN_RP_ID` | `FRONTEND_URL` のホスト名から自動 | RP ID。登録 (`rpID`) と Cernere 自身の assertion 検証 (`expectedRPID`) の双方で使う |
| `WEBAUTHN_ORIGINS` | `FRONTEND_URL` (カンマ区切りで複数可) | 受け付ける origin。passkey を作る PWA の origin はここに含める |
| `WEBAUTHN_RP_NAME` | `APP_NAME` → `Cernere` | パスキー UI に出る表示名 (検証には無関係) |

- 定義: `server/src/config.ts:98-110` (`webauthnRpName` / `webauthnRpId` /
  `webauthnOrigins`)
- 消費: `server/src/http/passkey-handler.ts:49-51` →
  登録 `rpID` (`:141`)、登録 finish `expectedRPID` (`:179`)、
  認証 `expectedRPID` (`:243` / `:282`)

### Ostiarius — 会場ゲートウェイ (assertion オフライン検証)

| env | 要否 | 用途 |
|---|---|---|
| `OSTIARIUS_RP_ID` | **必須** (未設定なら起動停止) | `expectedRPID`。**Cernere の `WEBAUTHN_RP_ID` と完全一致させる** |
| `OSTIARIUS_PWA_ORIGIN` | **必須** (未設定なら起動停止) | `expectedOrigin` + CORS 許可 origin。passkey を作る PWA の origin |

- 定義: `server/config.ts:59-60` (`rpId` / `pwaOrigin`、いずれも `requireEnv`)
- 消費: `server/routes/checkin.ts:67` (`generateAuthenticationOptions` の
  `rpID`)、`:113` (`expectedOrigin`)、`:114` (`expectedRPID`)。
  CORS は `server/index.ts:49` で `pwaOrigin` のみ許可。
- 起動ログ: `server/index.ts:107` が `rpId=… pwaOrigin=…` を出すので、
  本番投入後ここで実値を目視確認する。

### Aedilis — PWA 配信 + 出席記録 (本ガイドのリポ)

| env | 要否 | 用途 |
|---|---|---|
| `AEDILIS_PUBLIC_URL` | **必須** | 自身の公開 URL。**PWA (`/checkin.html`) を配信する origin** であり、ここが passkey の origin になる。Cernere `WEBAUTHN_ORIGINS` と Ostiarius `OSTIARIUS_PWA_ORIGIN` の両方に同じ値を入れる |

- 定義/消費: `server/index.ts:56` (`AUDIENCE = requireEnv('AEDILIS_PUBLIC_URL')`)

> Aedilis 自身は passkey の登録も assertion 検証もしない (検証は Ostiarius、
> 登録は Cernere)。Aedilis が WebAuthn に関わるのは「PWA を配る origin」と
> いう一点のみ。だが **その origin が 3 者の整合の基準点**になる。

---

## 3. 推奨ドメイン構成 (具体例)

eTLD+1 = `example.com` を全員の RP ID に揃える例。

| 役割 | ホスト | RP ID として使う値 | origin |
|---|---|---|---|
| Cernere (ログイン/passkey 登録) | `auth.example.com` | `example.com` | `https://auth.example.com` |
| Aedilis PWA (チェックイン画面) | `checkin.example.com` | (登録/検証しない) | `https://checkin.example.com` |
| Ostiarius (会場ゲートウェイ) | 会場 LAN (例 `https://gw.local`) | `example.com` | `https://checkin.example.com` |

ポイント:

- **RP ID は全員 `example.com`** (eTLD+1)。`auth.` でも `checkin.` でもなく
  共通の親ドメインに揃える。こうすれば `auth.example.com` で登録した passkey を
  `checkin.example.com` の PWA から使い、Ostiarius が検証できる。
- **passkey を作る origin は Aedilis PWA の `https://checkin.example.com`** ひとつ。
  この origin が Cernere の登録 origin と Ostiarius の検証 origin の双方に
  含まれていなければならない。
- **Ostiarius は会場 LAN 上で動く**が、RP ID は会場の LAN ホスト名ではなく
  `example.com` に揃える (RP ID は「どこで検証するか」ではなく「passkey が
  どのドメインに紐づくか」)。Ostiarius へは https でアクセスする
  (PWA からの fetch が mixed-content にならないよう、LAN でも TLS を張る)。

---

## 4. userVerification (UV) は登録・検証とも required

端末貸し対策 (生体/PIN を毎回要求) のため、UV は登録側も検証側も `required` で
揃えてある (Cernere #116 / Ostiarius)。env では制御せずコードで固定。

| 箇所 | 設定 | 参照 |
|---|---|---|
| Cernere 登録 | `authenticatorSelection.userVerification: "required"` | `server/src/http/passkey-handler.ts:158` |
| Ostiarius nonce 発行 | `userVerification: 'required'` | `server/routes/checkin.ts:68` |
| Ostiarius assertion 検証 | `requireUserVerification: true` | `server/routes/checkin.ts:115` |

→ 登録時に UV 必須で作られた passkey だけが台帳に入り、検証時も UV 必須で
弾かれないよう整合している。**ここを片側だけ緩めない** (登録 required ×
検証非 required は端末貸しを通してしまう)。

---

## 5. 設定チェックリスト

### env 例 (本番、eTLD+1 = `example.com`)

```sh
# ── Cernere ──────────────────────────────────────────
WEBAUTHN_RP_ID=example.com
WEBAUTHN_ORIGINS=https://auth.example.com,https://checkin.example.com
WEBAUTHN_RP_NAME=LUDIARS

# ── Ostiarius (会場ゲートウェイ) ─────────────────────
OSTIARIUS_RP_ID=example.com
OSTIARIUS_PWA_ORIGIN=https://checkin.example.com

# ── Aedilis (PWA 配信 + 出席記録) ────────────────────
AEDILIS_PUBLIC_URL=https://checkin.example.com
```

### 確認項目

- [ ] `WEBAUTHN_RP_ID` (Cernere) == `OSTIARIUS_RP_ID` (Ostiarius) が
      **完全一致** (大文字小文字・末尾なし含めて1文字も違わない)
- [ ] その RP ID が eTLD+1、または PWA ホストの登録可能サフィックスである
      (`checkin.example.com` に対し `example.com` は OK、`auth.example.com` は NG)
- [ ] `AEDILIS_PUBLIC_URL` (= passkey を作る PWA origin) が
      Cernere `WEBAUTHN_ORIGINS` に **含まれている**
- [ ] `AEDILIS_PUBLIC_URL` == `OSTIARIUS_PWA_ORIGIN` (検証側 origin と一致)
- [ ] 全 origin が `https://` (localhost を除き http 不可)
- [ ] Ostiarius 起動ログ `[ostiarius] rpId=… pwaOrigin=…` の実値が上記と一致
- [ ] UV は登録 (Cernere #116) / 検証 (Ostiarius) とも `required` のまま
      (§4、コード固定なので env では触らない)

---

## 6. 関連配線

### Ostiarius 公開鍵の自己登録

Ostiarius は起動時に Ed25519 attestation 公開鍵を Aedilis へ自己登録できる
(両方揃って初めて有効、無ければ admin が手動 provision)。

| env (Ostiarius 側) | 用途 | 参照 |
|---|---|---|
| `AEDILIS_BASE_URL` | 自己登録の宛先 = Aedilis の公開 URL | Ostiarius `server/config.ts:65` |
| `AEDILIS_ADMIN_TOKEN` | 自己登録に使う admin Bearer | Ostiarius `server/config.ts:66` |

→ 登録先は Aedilis の `POST /api/admin/gateways` (`server/routes/checkin.ts:62`、
admin 認証)。手動登録時はここに `lanId` / `publicKeyPem` / `facilityId` を投げる。

### Memoria への出席イベントは relay 経由

出席記録に成功すると Aedilis は `MEMORIA_WEBHOOK_URL` へ fire-and-forget で
POST する。**直 Memoria ではなく Imperativus / Legatus relay の出席エンドポイント
を指すのが正** (relay → Memoria ingest)。Memoria への online 直接 write は不可
([[feedback_memoria_online_flow]])。

- 実装/向き先のコメント: `server/checkin/notify.ts:1-9, 19`
- README の env 説明: [`../../README.md`](../../README.md) 「出席チェックイン用」節
- 基本 env は [`./setup.md`](./setup.md)、検証フロー全体は
  [`../../checkin-spike/CONTRACTS.md`](../../checkin-spike/CONTRACTS.md)
