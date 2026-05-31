# カレンダー連携（Schedula / Google）— v0.3+（計画）

> **状態: 未実装（v0.3 以降）。** 設計は [`../../DESIGN.md`](../../DESIGN.md) §3.3 / §8。
> 本ドキュメントは計画仕様。実装時に振る舞いを確定する。

## 目的
施設予約を予定（カレンダー）として外部（Schedula / Google Calendar）へ反映し、
双方向に同期する。Aedilis は「施設予約 + 予定の登録/反映」を担う。

## 計画する振る舞い
- **Outbound**（[`../../DESIGN.md`](../../DESIGN.md) §8.1）: 予約の作成/変更/取消を
  Schedula / Google Calendar のイベントへ反映。
- **Inbound**（§8.2、v0.1 計画は Schedula のみ）: 外部側の変更を取り込み、予約と
  整合させる。
- 冪等性・重複反映防止（同じ予約を二重にイベント化しない）を担保する。

## 関連
- 役割境界（Schedula / Calicula / Google Calendar との分担）は
  [`../../DESIGN.md`](../../DESIGN.md) §2。
- 反映先イベントは予約（[`reservation.md`](reservation.md)）に対応づく。
