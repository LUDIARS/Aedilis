---
task: checkin-gateway-verify
project: Aedilis
kind: 実装
status: done
---

# kiosk 直送の出席 attestation 受理

## 目的

Ostiarius kiosk が、生徒端末の Cernere token を中継せずに、登録済み gateway として
Aedilis へ安全に出席 attestation を送れるようにする。同時に本人確認手段と保証水準を
保存し、管理者が例外経路と passkey 偏重を把握できるようにする。

## 完了条件

- [x] `method` / `assurance` と旧形式 attestation の互換受理を契約・型・DB に反映する。
- [x] gateway token は登録時に一度だけ発行し、ハッシュだけを保存して gateway 直送を認可する。
- [x] 共通の署名検証・鮮度・重複判定を用いて `/api/checkin/gateway-verify` を提供する。
- [x] `CHECKIN_MIN_ASSURANCE`、staff override 集計、passkey 連続利用注意を追加する。
- [x] `/api/checkin/events-summary` に gateway token を使う件数サマリー保存を追加する。
- [x] Vitest と型検査を実行する。
