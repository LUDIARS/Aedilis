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
