---
title: GPS + 写真チェックインの Aedilis 側 (判定と記録, G3)
task: gps-photo-checkin
project: Aedilis
kind: implementation
created: 2026-10-05
source_session: lictor-2fe91fe0-e765-4cb7-8221-a969d26222a7
actio_reference: actio:2b034e1b-7393-4494-a043-89d2132ae1dc
---

# GPS + 写真チェックインの Aedilis 側 (判定と記録, G3)

## 実装内容

`POST /api/checkin/gps` を追加し、CONTRACTS §6 G3 の検証 1〜7 を固定語彙のエラーコードで実装した。
写真はメモリ上で検証して捨て、`gps_checkin_photo` には SHA-256・Exif 撮影時刻・判定結果・距離だけを残す。
attendance の method に `gps` を追加 (assurance `low`)。位置の宣言 (purpose "location") を
attestation 経路へ投げた場合は `purpose_mismatch` で拒否する。Actio 本文は複製せず上記参照で関連付ける。

## 再利用の判断

- 署名検証は attestation.ts の Ed25519 / gateway_registry をそのまま使い、署名だけを検証する
  `verifySignedJson` を切り出して位置の宣言と共用した。
- 予約照合 (`findMatchingReservation`)・記録 (`insertAttendance`)・Memoria webhook (`notifyAttendance`) は既存を流用。
- Exif 読み取りはライブラリを入れず自前実装 (`server/checkin/exif/`)。必要なのは DateTimeOriginal /
  OffsetTimeOriginal / GPS の 4 タグだけで、JPEG APP1 と HEIC Exif item の取り出しを含めて約 300 行。
  候補の exifr は依存ゼロだが 2021 年以降リリースが止まっており、未使用機能 (XMP/ICC/IPTC/サムネイル) が
  信頼できない入力の攻撃面を広げるため採らなかった。

## 作業分解

- [x] 契約 manifest (C-3, C-4) と述語を実装より先に作成
- [x] Exif パーサ (TIFF / JPEG / HEIC) と撮影時刻の変換
- [x] 位置の宣言の検証・haversine・レート制限・入力検査
- [x] 判定オーケストレーション (gps-service.ts) とルート
- [x] DB (gps_checkin_photo, method gps) と出席履歴での方式・確度表示
- [x] CONTRACTS.md §6 / rest-api.md 更新
- [x] 回帰テスト
- [ ] 契約の実呼び出し証跡 (Aedilis に contract runtime が未整備で未注入)

## 検証

Augur plan は `spec/test/gps-photo-checkin-plan.json` (characterization 提案のみ)。
test/exif.test.ts・test/gps-checkin.test.ts・test/gps-checkin-route.test.ts で各エラーコード、距離・鮮度・
精度・時刻窓の境界、Exif 欠落・時刻窓外・Exif 位置の範囲外、同一ハッシュ / 同一利用者同一撮影時刻の再利用、
正常系の記録 (method/assurance)、写真本体を保存しないこと、レート制限を記述した。
vitest 20 files / 177 tests 成功、frontend typecheck・build:web 成功。server typecheck は
`lib/vestigium` (submodule 未取得) の既存エラー 1 件のみで、本変更起因のエラーは無い。
サービス起動・実機テストは未実施。

## 受け入れ条件

C-3 processGpsCheckin(db, input, userId): 拒否は固定語彙のエラーコードのみで返し、受理時は attendance に method="gps"・assurance="low" で記録し、写真行には SHA-256・撮影時刻・判定結果・距離だけを残す (写真本体・Exif 位置は保存しない)
C-4 processCheckin(db, attestation, authorization): purpose "location" の位置の宣言は出席として受理しない (署名が正規なら purpose_mismatch 403)
