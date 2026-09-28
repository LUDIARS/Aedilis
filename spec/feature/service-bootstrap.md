# SPEC-AEDILIS-BOOTSTRAP

service-runtimeは導入時の依存準備・画面ビルドを所有する支援境界。scripts/site/setup.mjsは引数なし・非対話でロック済依存と画面を準備し、失敗時は非0終了する。npm呼出は同じNode・明示cwd・shellなしで行う。

不変条件: setupはSQLite、秘密、設定を上書きしない。サービス起動とスキーマ初期化は通常runtime/Excubitorが所有する。data-export/importは未対応エラーで停止し、成功を偽装しない。
