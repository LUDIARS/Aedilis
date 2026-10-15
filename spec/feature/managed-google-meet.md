# Managed Google Meet

The Ae administrator authorizes a licensed Workspace organizer account. Meeting creators
sign in through Cr and verify their own Google account via a separate code/PKCE flow.
An online-enabled meeting owner can create its managed Meet from the meeting page.
The organizer owns the space, the verified creator becomes COHOST, host management is
enabled, and `autoTranscriptionGeneration=ON`. If creator and organizer are the same
Google account, existing host privileges suffice. Google starts transcription when an
eligible host/cohost joins; setting ON does not itself capture an empty meeting.

## SPEC-MANAGED-MEET-AUTH

- `POST /api/meet/oauth/start`: Cr project identity, same-origin JSON, mode creator/organizer.
- Organizer mode additionally requires `AEDILIS_ADMIN_IDS` membership.
- State is one-use, ten-minute, tied to Cr user and HttpOnly browser cookie; PKCE S256.
- Callback exchanges the code server-side, then obtains verified email/sub from Google's
  fixed userinfo endpoint. Google identity never substitutes for Cr authentication.
- Workspace organizer requires a hosted domain, offline refresh token and both Meet scopes.
- OAuth access/refresh tokens and Google identity metadata live encrypted in Cr's existing
  `managed_project.store_oauth_token`, provider `google`, under the Ae project/user.
- Ae stores only the Cr user reference, transient PKCE state and space provisioning state.
- Do not change the Google identity after it has been assigned to an existing managed Meet.

## SPEC-MANAGED-MEET-PROVISION

- `POST /api/meet/:meetingId` requires Cr authentication and existing meeting ownership.
- Refuse cancelled meetings and meetings with online participation disabled.
- Save creation intent before the non-idempotent Google call. An uncertain response or
  process crash must not trigger another space creation automatically.
- Save the space before configuring it. Retry settings/member operations on that same space;
  list members first so a lost member-create response does not duplicate a cohost.
- A usable link is returned only after settings and membership succeed.
- `GET /api/meet/:meetingId` requires Cr; cancelled meetings do not expose the link.
- Uncertain creation requires administrator investigation in Google. There is deliberately
  no blind reset/create button. Cancelling a poll does not delete a Google space.

## SPEC-MANAGED-MEET-GLAB-RELAY

GLab (neco 2026-10-14「Ae と接続し、Meet のリンクを発行した予定を登録できるようにする。Meet の代表者になる
アカウントは GLab でログインする」) relays the same API through its facility proxy. A relayed request carries the
v1 `x-glab-booking-context` assertion (HMAC over Cr user, method, path and body hash, 30 s); a valid assertion
replaces the Ae same-origin check, an invalid one is refused (403) instead of falling back.

- `POST /api/meet/oauth/start` with `redirectUri`: relayed requests only, and a relayed request must name one (it never
  falls back to Ae's callback). The URI must exactly match the relaying front end's own list — GLab:
  `AEDILIS_MEET_GLAB_REDIRECT_URIS` (earlier name `AEDILIS_MEET_EXTERNAL_REDIRECT_URIS`, read only when the new one is
  unset; comma separated, HTTPS or loopback HTTP, no query/fragment) — and must also be an authorized redirect URI of
  the Google OAuth client. No Ae cookie is set; the state row is bound to the Cr user and to the front end
  (`return_path` = `external:<source>:<uri>`, no schema change).
- `POST /api/meet/oauth/complete` `{ state, code }`: relayed requests only, by the same Cr user through the same front
  end that started it. The Ae page callback never completes an external state and the external completion never
  completes an Ae state.
- Organizer mode without an organization still requires `AEDILIS_ADMIN_IDS` (Ae's representative).

## SPEC-MANAGED-MEET-CALLBACK-PER-EMBEDDING

neco 2026-10-15「GLAB に組み込んだ (GLAB 経由で呼び出された) Ae のコールバックは GLAB にしたいが、Ae 単品や別のサービスに
組み込まれた場合はコールバックを分けたい」.

- Ae's own page: Google returns to `AEDILIS_PUBLIC_URL` + `/api/meet/oauth/callback` (Ae cookie binding).
- GLab (requests carrying a valid `x-glab-booking-context`): Google returns to GLab's callback from
  `AEDILIS_MEET_GLAB_REDIRECT_URIS`. GLab cannot use another embedding's URIs and cannot complete their flows.
- Another embedding gets its own relay source and its own redirect list (`MeetConfig.externalRedirectUris[source]`);
  until it is added, only Ae's page and GLab can start a Google authorization.

## SPEC-MANAGED-MEET-ORGANIZATION-REPRESENTATIVE

neco 2026-10-15「Meet の代表アカウントは、GLAB の組織で予約した場合 GLAB の代表で登録したい。組織の代表者アカウントとしたい」.

- GLab signs `representative: true` on an organization in the booking context when the caller is that Cr
  organization's `owner`. Ae trusts the flag only inside a verified assertion and only on organizations.
- `POST /api/meet/oauth/start` `{ mode: 'organizer', organizationId, redirectUri }` (relayed only): the caller must
  represent that organization at start and again at completion. The organizer grant is saved to
  `meet_group_organizer(group_kind='organization', group_id, user_id)`; Ae's own representative is not changed.
- `GET /api/meet/status` adds `organizations: [{ id, name, organizerConnected, isOrganizer }]` for the organizations
  the caller represents (never other members' Google accounts).
- `POST /api/meet/:meetingId`: a meeting whose audience group is an organization is hosted by that organization's
  representative when one has authorized, otherwise by Ae's representative. The host is fixed at the first attempt.
- A representative (Ae's or an organization's) cannot run the creator link, which would replace its organizer token.

Tests: `test/meet-glab-relay.test.ts`, `test/meet-oauth.test.ts`.
- `POST /api/meet/:meetingId` relayed: the creator's own Google link is optional. When it is missing the
  representative account hosts alone (no COHOST member). Ae's own page keeps requiring the creator's link.

Tests: `test/meet-glab-relay.test.ts` and the optional-creator case in `test/managed-meet.test.ts`.

## Setup

1. Enable Google Meet API in the Google Cloud project and configure its consent screen.
2. Configure a Web OAuth client redirect URI:
   `https://ae.ai-run-do.com/api/meet/oauth/callback`.
3. Store `AEDILIS_GOOGLE_CLIENT_ID` and `AEDILIS_GOOGLE_CLIENT_SECRET` using Ae's secret
   management. Configure the Cr public login URL and authorized Ae admin user IDs.
4. Administrator signs into Cr from Ae, chooses the management-account authorization button,
   and grants `openid email meetings.space.created meetings.space.settings`.
5. Creator signs into Cr and confirms their Google account, then creates Meet from an
   online-enabled meeting. Google tokens are never returned to the browser.

Calendar synchronization, transcript download and Gemini summaries are separate work.
Tests: `test/managed-meet.test.ts`, `test/meet-oauth.test.ts`, `test/meet-routes.test.ts`.
Sources: https://developers.google.com/workspace/meet/api/guides/meeting-space-members
and https://developers.google.com/workspace/meet/api/guides/meeting-spaces-configuration .
