---
title: Aedilis の起動を Excubitor Vault-only に統一
task: vault-only-startup
project: Aedilis
kind: implementation
created: 2026-10-03
source_session: lictor-f84c0ba2-9373-41ed-b05b-e87f4d71450b
actio_reference: actio:57737931-349c-43a0-80fe-7d65b26a948e
---

# Aedilis の起動を Excubitor Vault-only に統一

## 実装内容

起動時の秘密取得を廃止し、Excubitor 注入済み env の検査後に本体を import する。
従来の警告継続を必須4変数の fail-fast に変更し、管理者IDは任意のまま維持した。
dev/start の dotenv オプション、env:*、env-cli.config.ts を撤去し、起動資料を更新した。
Actio 本文は複製せず上記参照で関連付ける。

## 再利用の判断

既存 env-bootstrap.ts を入力検査専用に縮小し、index.ts の必須検査も防御として維持。
Vestigium の既存初期化と Cernere 起動資格情報の発行経路を再利用した。
別の secret client や依存追加は不要。AEDILIS_PROJECT_KEY は実コードで未使用のため
catalog に追加していない。秘密値・既存 dotenv・他リポ・稼働サービスには触れていない。

## 作業分解

- [x] 契約 manifest / 述語を実装より先に作成
- [x] 起動前の必須検査と旧取得処理の撤去
- [x] スクリプトと仕様の更新
- [x] 回帰テストの追加
- [ ] 契約の実呼び出し証跡（テスト実行は審査に委任）

## 検証

Augur plan は `spec/test/vault-only-startup-plan.json`。契約・characterization の提案に対応し、
test/env-bootstrap.test.ts で必須4変数の個別欠落・空文字・空白、管理者ID省略、
入力不変、変数名のみのエラー、旧資格情報による代替不可、述語の誤判定防止を記述した。
成功入力の既存挙動を維持し、不足入力は仕様どおり警告継続から停止に変更する。
契約 lint は findings なし。単体・統合テスト、typecheck、サービス起動は未実行。
契約注入は Anatomia の領域外ログ書込みが EPERM で失敗し、未注入・未観測。
DELEGATION_STARTED_AT は未設定のため、集計開始時刻は Cc run.created_at を使用する。

## 受け入れ条件

C-1 assertRequiredEnv(env): 必須4変数が非空なら成功し、不足時は変数名のみのエラーで停止する。管理者IDは任意

実呼び出し証跡の未取得は合格扱いせず、Augur 集計を委託報告にそのまま添付する。
提出境界は Concordia commit と Revisor local PR。merge・push・サービス反映は行わない。
