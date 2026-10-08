# Discord respondent handoff (SPEC-AE-DISCORD-RESPONDENT-01)

The user selected direct meeting-respondent identity, without a Cernere login,
and authorized the Concordia bot integration on 2026-10-08. Issuance is limited
to members of the configured Discord organization (BOTTEST for this rollout).

The bot verifies current guild membership and an application-owned announcement,
then privately issues a cryptographically random, five-minute, single-use link
bound to that meeting and guild. Concordia stores only the token hash and checks
membership again when Aedilis exchanges it. Aedilis accepts proofs only from its
configured issuer and guild; raw client-provided Discord IDs are never trusted.

The browser removes the fragment before other page activity and asks the user
to continue as the Discord respondent. Exchange uses a same-origin JSON POST.
Successful exchange establishes a meeting-scoped HttpOnly cookie. Discord IDs
are private; only the user's own display name is returned to the browser.

The identity is scoped to one meeting and cannot create or manage meetings,
read private/group meetings, bypass disabled guest responses, or become a
Cernere identity. Existing anonymous/Cernere responses are not merged or
reassigned. A repeat visit by the same Discord user selects their existing
Discord response. Expired, reused, foreign-guild and revoked-member proofs fail
with a visible instruction to obtain another link.

Runtime configuration and live message replacement are enabled only after both
services have the corresponding implementation. A pending handler must not be
advertised by changing the original Discord announcement early.
# 作業・検証記録

Actio: a342bb78-7ac9-4e94-9b17-1bb1e2271423。neco の「回答者ですAが正しい」を根拠とする。
成立した回答者 cookie は予定限定・12時間。cookie 名をグローバル匿名用へ付け替えてもサーバーの予定所属検査で拒否する。解除時は当該端末の証明を失効させる。
組織所属は Cc の発行時と消費時に照合する。成立済みセッションの毎リクエスト照合は行わない。
通常 webhook は対話ボタンを扱えないため、反映時は Bot 投稿を用い、元投稿から誘導する。投稿結果不明時は同じ投稿を再送しない。
テストは追加済み。実行・サービス再起動は人間の許可待ち。
