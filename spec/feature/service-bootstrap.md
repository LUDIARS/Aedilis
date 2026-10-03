# SPEC-AEDILIS-BOOTSTRAP

service-runtimeは導入時の依存準備・画面ビルドを所有する支援境界。scripts/site/setup.mjsは引数なし・非対話でロック済依存と画面を準備し、失敗時は非0終了する。npm呼出は同じNode・明示cwd・shellなしで行う。

不変条件: setupはSQLite、秘密、設定を上書きしない。サービス起動とスキーマ初期化は通常runtime/Excubitorが所有する。data-export/importは未対応エラーで停止し、成功を偽装しない。

通常起動は Excubitor の Vault-only env 注入を前提とする。`server/bootstrap.ts` は
`assertRequiredEnv(process.env)` で必須4変数を検査し、成功した場合だけ `index.ts` を import する。
不足時は許可された変数名のみのエラーとなり、DB・HTTP の起動前に停止する。
`AEDILIS_ADMIN_IDS` は任意。アプリ自身の secret 取得と dotenv 読み込みは行わない。
受け入れ契約と検証範囲は [移行タスク](../tasks/vault-only-startup.md) を参照。
