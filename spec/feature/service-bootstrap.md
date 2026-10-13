# SPEC-AEDILIS-BOOTSTRAP

service-runtimeは導入時の依存準備・サーバー/画面ビルドを所有する支援境界。scripts/site/setup.mjsは引数なし・非対話でログ用submoduleのロック済依存とビルド、アプリのロック済依存とビルドを準備し、両方の開発依存を除去する。失敗時は非0終了する。npm呼出は同じNode・明示cwd・shellなしで行う。

通常起動は `node dist/server/bootstrap.js`。実行時にtsx・compiler・watcher・画面ビルドを要求しない。`tsconfig.build.json`はNodeNextでサーバーのみを出力し、相対.ts importを.jsへ変換する。JSON設定も出力される。既定DB/施設マスタは本体checkoutのcwd基準とし、dist以下へ移動しない。Excubitorのcwdは本体checkout rootを維持する。

catalogの `build_command` は `node scripts/site/setup.mjs`。通常のdeploy/reflectでも開発依存を再導入してビルドし、終了時に除去する。初回bootstrap後のprune済みcheckoutで `npm run build` だけを呼び、compiler不足で反映に失敗する経路を作らない。

不変条件: setupはSQLite、秘密、設定を上書きしない。サービス起動とスキーマ初期化は通常runtime/Excubitorが所有する。data-export/importは未対応エラーで停止し、成功を偽装しない。

通常起動は Excubitor の Vault-only env 注入を前提とする。`server/bootstrap.ts` は
`assertRequiredEnv(process.env)` で必須4変数を検査し、成功した場合だけ `index.ts` を import する。
不足時は許可された変数名のみのエラーとなり、DB・HTTP の起動前に停止する。
`AEDILIS_ADMIN_IDS` は任意。アプリ自身の secret 取得と dotenv 読み込みは行わない。
受け入れ契約と検証範囲は [移行タスク](../tasks/vault-only-startup.md) を参照。
