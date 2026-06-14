# Aedilis 出席チェックイン — Step1 スパイク

prototyping-flow **Step 1(粗く動かす)**。 出席アプリの一番リスクが高い新規メカニズムだけを最短で「動いた」状態にするための雑な検証コード。 Foundation UI 化 / Cernere SSO 統合 / 予約照合 / テストハーネスは **まだ入れない**(Step 2 以降)。

## 証明したい一周

1. **[LAN]** 会場ゲートウェイが nonce(challenge)を発行
2. **[端末]** PWA が端末の **passkey** で nonce に署名(WebAuthn assertion・生体ゲート)
3. **[LAN]** ゲートウェイが **登録済み公開鍵だけでオフライン検証**(Cernere に問い合わせない=家からは LAN に届かず不成立)
4. **[LAN]** OK なら **presence-attestation** をゲートウェイ鍵(Ed25519)で署名
5. **[クラウド/別環境]** PWA が attestation を **別環境の Aedilis にリレー** → ゲートウェイ公開鍵で検証 → 出席記録

## 2サービス構成(別環境を反映)

| プロセス | 役割 | 本番での対応 | port |
|---|---|---|---|
| `gateway-server.ts` | 会場LANゲートウェイ(仮称 **Ostiarius**)。 nonce 発行 + assertion オフライン検証 + attestation 署名 + PWA 配信 | 会場のラズパイ/PC に置く独立サービス。 登録(`/reg/*`)は本番では Cernere passkey レジストリへ移す | 17590 |
| `cloud-server.ts` | クラウド側 = **Aedilis** 本体の stub。 attestation 検証 + 出席記録 | Aedilis に内包(検証層→記録は Placement、 予約照合) | 17591 |

attestation は **PWA がリレー**する(ゲートウェイがネット不通でも成立)。 ゲートウェイ公開鍵は **初回セットアップで一度きり provision**(スパイクでは cloud が初回 verify 時に gateway から取得してキャッシュ)。

## 動かし方

```bash
cd E:/Document/Ars/Aedilis/checkin-spike
npm install

# ターミナル1: 会場ゲートウェイ(PWA も配信)。 起動前に client.js を自動ビルド。
npm run dev:gateway      # → http://localhost:17590

# ターミナル2: クラウド(Aedilis stub)
npm run dev:cloud        # → http://localhost:17591
```

ブラウザで **http://localhost:17590** を開く(WebAuthn は localhost を secure context 扱いするので動く):

1. **「① 初回登録」** → OS の生体認証 → passkey 作成(初回だけ)
2. **「② チェックイン」** → 生体認証 → 画面ログに `✅ 出席確定` と attestation payload が出れば成功

クラウド側の記録は `GET http://localhost:17591/attendance` で確認できる。

> 注: WebAuthn は実機の生体/PINジェスチャが要るので、 観測(ボタン押下+認証)は手動。 自動テストは Step 2 以降。

## Step 1 で意図的に省いていること

- Cernere 連携(登録/検証)— ここでは passkey 登録をゲートウェイに同居
- Aedilis 予約との照合、 Placement への記録、 Memoria 連携
- Foundation UI、 PWA manifest/service worker、 オフライン対応
- ゲートウェイ鍵の永続化(現状は起動毎に揮発)
- LAN 到達性そのものの強制(本番は別マシン/別ネット。 ここでは localhost 同居)
