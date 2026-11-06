# Meetings PKCE と自前 session

## SPEC-MEETING-SCOPED-LOGIN

Actio: `actio:4e6c8a10-8f40-46e5-b9d3-47bb5691920c`。
親の認証統合設計: `actio:e0acdef1-32ef-40a8-bc38-be2250bed9cb`。
公開 URL・複数端末設定の既存 Ae タスクとは別の変更単位である。

ブラウザは Web Crypto で 32 byte の PKCE verifier と独立 state を生成し、S256 challenge、
登録 client_id、現在の origin、state を Cr の `/composite/login` へ渡す。
応答は popup の source、Cr の origin、state、応答種別を照合する。verifier はメモリだけに保持し、
Ae の nonce Cookie と一致する一度限りの complete に送る。連打は無視し、開始から交換・link 完了まで
同じ所有者が busy を維持する。popup 終了・timeout・pagehide・再 setup/dispose・logout で
AbortController、message listener、interval、popup を解放する。結果不明の通信は自動再送しない。

バックエンドは固定版 Composite SDK の project credential で code+verifier を一度交換し、
ランダムな Ae session ID に Cr grant を bind する。global access/refresh/local JWT は発行しない。
ブラウザに渡すのは `__Host-aedilis_meeting_session` の opaque ID だけであり、Secure、HttpOnly、
SameSite=Strict、Path=/、Domain 無しとする。HTTP の直接ログインは拒否する。
session の期限は bind 応答の原期限かつ開始から15分以内。check による延長は拒否する。

nonce の claim は最初の await より前に実行し、交換結果不明でも再利用不可とする。
logout はローカル session と進行中 nonce を remote revoke より前に失効させる。
消費済み nonce は最大5分保持し、成功の Set-Cookie 応答より先に届く logout でも公開済み ID を
失効できる。remote revoke 失敗でローカル session を復元しない。check の並行成功でも
他の check 失敗・logout によって消えた session を再挿入しない。

session は router/process 所有のメモリに最大各10,000件保持し、次の開始・bind 時に期限切れを除く。
再起動・dispose・別プロセスでは再ログインとなる。多 replica の共有 session store はこの変更に含めない。
Cr の grant/tombstone がリモートでの原子的 bind と再 bind 拒否を所有する。

## SPEC-MEETING-SCOPED-OPERATION

直接 meetings の認証には旧 `cernere_token` と Bearer を使わない。旧資格情報または別用途の
generic auth が提示された要求は401で明示拒否し、guestへ降格しない。generic readIdentityへの
fallbackは行わない。資格情報なしの公開guest/device経路と、別用途のmanaged Meet認証は維持する。
認証 Cookie が提示された場合、
期限切れ・不明・オンライン照会不明はその要求を拒否し、guest として続行しない。
guest device、meeting 単位の Discord respondent、検証済み GLAB assertion は従来の独立契約を維持する。
自前 session と GLAB assertion の同時提示は拒否し、自前 session と Discord identity を混ぜない。

認証済み要求は `operation-policy.ts` の厳密な method/path allowlist で action と risk を決める。
未知の action は拒否する。機密 GET を含め、固定 SDK の `sessions.run` が session binding、
action、実際の pathname+query、正確な本文 digest、要求毎のランダム request ID を結んだ
一度限りのオンライン permit を消費する。read/sensitive_read/important の不一致も拒否する。
この分類一覧が管理者 `service_operations` の設定資料となる。

Cr consume 後、同じ Ae DB transaction 内で現在の identity、公開範囲、meeting owner、response owner
を再照合してから handler を実行する。一覧は各行を現行 ACL で絞る。handler/repository 内の
organizer、participant、revision、guest 受付条件も維持する。active/role は ACL の代用にしない。
session 系変更は GLAB proxy の Origin 例外を認めず、Ae の厳密な Origin と JSON を要求する。
Cr permit 消費と Ae DB は分散 transaction ではなく、DB 結果不明でも自動再実行しない。

## 設定・切替境界

`CERNERE_PROJECT_CLIENT_ID` と `CERNERE_PROJECT_CLIENT_SECRET` は既存 Ex の標準注入を再利用し、
欠落時は起動境界の純粋な `requireMeetingAuthConfig` 検証で明示エラーとする。
設定の読取自体は他モジュールのOAuth設定確認を妨げない。公開 `/config` は client_id のみ返し、secret/token を返さない。
`AEDILIS_PUBLIC_URL` は登録 hub/origin、`AEDILIS_CERNERE_PUBLIC_URL` は popup の Cr origin と整合させる。
管理者は Cr の Ae project に composite_origins、hub_url、上記全 action の service_operations と
対応 consent を設定する。設定値・secret 実データにはこの作業で触れない。

SDK は Cr `b2bc69cf2130c719fa4db3db9cdcf44f4c5f5836`（Revisor #3627 merged）へ固定する。
全 consumer/target/管理者設定が揃った後の一斉切替は親担当が所有する。
施設予約・GPS・Google・Discord・GLAB の別契約全体の移行、配備、実観測は本 PR の完了に含めない。

## 契約と検証

C-5 MeetingSessions.completeLogin(nonce,code,verifier): PKCE を一度交換し原期限内の自前 session を bind する。
C-6 MeetingSessions.run(id,operation,risk,authorize,execute): オンライン許可消費後に現在 session と対象 ACL を確認し一度だけ操作する。

Augur plan の「既存挙動の固定」を、PKCE/state/source/origin、nonce/replay、並行 logout/check、
15分上限、authority 障害・risk drift、現在 owner ACL、guest 非混同、正確な操作本文のテストへ具体化した。
テストは Revisor で実行する。担当 session は型・静的確認のみで、実行成功の証跡を自己申告しない。
