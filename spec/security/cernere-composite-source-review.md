# Composite backend SDK 取込審査

対象タスク: `actio:4e6c8a10-8f40-46e5-b9d3-47bb5691920c`。
審査日: 2026-11-06。審査者: Ae 実装担当 Codex。
取得元: ローカル Cernere の Revisor #3627 確定 merge
`b2bc69cf2130c719fa4db3db9cdcf44f4c5f5836`。GitHub 最新版の追跡はしない。
この承認済み固定成果物を使う指定であり、origin HEAD の最新性を根拠にしない。

`external-import-history.mjs` により非 shallow ローカル Git の直近7日全 ref patch を
`.local/import-review/cernere-history.json` へ採取した。対象期間内の package 変更は確定 merge に集約されている。
履歴は packages/composite/package.json と対象 TypeScript に加え、同期間の `.github` 変更を照合した。
以前の Ae accepted SDK baseline は無いため、取り込む5モジュールの初期全ソースも読んだ。
配布 npm archive は使わず、Git object から取得したバイト列を source-lock.json の SHA-256 と照合する。
審査記録は command/cwd に束縛した `.claude/import-reviews/` の JSON に残す。

## 差分・依存・実行対象

旧 Composite の service-adapter/WebSocket/local JWT/refresh を廃止する変更を確認した。
取り込むのは composite、service-session、types、delegation、service-identity の5ファイルだけ。
backend の import 閉包はこの5ファイルと `node:crypto` だけである。
React UI、WebAuthn、npm main/index、native binary、minified/generated payload、CI/publish script は
実行対象に含めない。package.json の build/prepublishOnly は tsc を呼ぶが、package 自体は install しない。
install hook を無効化する操作は行わない。package-lock.json と依存一覧は変更しない。

Node 標準の乱数・hash と共有 guard を採用し、暗号・JWT・署名を自作しない。
SDK の副 API (delegation/scoped identity) は import 閉包上必要なためそのまま保持するが、
本変更はそれらを呼ばない。上流 API を削って別 SDK を作るより、固定 source の一致を優先した。
MIT LICENSE を同梱する。C/C++/Rust unsafe/FFI/追加 native dependency はこの source import に無い。

## 通信と秘密情報

動的評価・プロセス起動・DNS/socket 直接利用・telemetry・バックグラウンド接続は無い。
通信先は constructor で検査する `cernereUrl` の HTTPS（開発時 loopback HTTP のみ許可）。
URL credential/query/hash/path は拒否し、全 fetch は redirect:error と期限・dispose abort を持つ。

- `/api/auth/login`: 必要時に project client_id/client_secret を送信し短命 project credential を取得。
- `/api/auth/exchange`: 明示ログイン時、project credential と code/code_verifier を送信する。一度だけ。
- `/api/auth/service/{bind,check,revoke,authorize,consume}`: 明示 session/操作時、project token と
  session hash、action/resource/body digest/request ID、必要時 permit を送信する。
- その他の SDK の delegate/identity 呼出しは本 consumer から使用しない。呼ばない限り通信しない。

secret は Ex の既存標準注入から backend メモリに渡し、SDK は環境全体やファイルを読まない。
token/secret は browser config、Cookie、ログへ出さない。必要な認証通信以外は確認されなかった。
実行による network 観測やログイン成功は未検証である。取込審査と動作成功を混同しない。

## 再現

`node scripts/import-cernere-composite.mjs <reviewed-local-cernere-repository>` は固定 Git object を読み、
全ハッシュが一致した場合だけ同じ vendor ファイルを再作成する。fetch/install/checkout はしない。
保存済み source-lock.json が取込バイト列の lock/integrity 正本である。
