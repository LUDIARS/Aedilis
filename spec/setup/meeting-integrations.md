# Meeting integration configuration

Entry: `/meetings`. Existing `/` facility booking remains available.
The web build includes `public/meetings.js`; run the existing build:web script
when preparing a deployment. No service has been started by this implementation.

## Google Calendar

Create a Google OAuth web client with Calendar API enabled and register Aedilis'
exact public origin in Authorized JavaScript origins. Set
`AEDILIS_GOOGLE_CLIENT_ID` (public identifier) through Excubitor's Vault binding for
`aedilis`. This is the same OAuth web client used by managed Google Meet; do not
create or configure a client per user, meeting, browser, or embedding service.
The former `server/meetings/settings.json` client setting is no longer read.
Move an existing nonempty JSON setting into the Vault entry before deployment.
The selected scopes are
`calendar.calendarlist.readonly` and `calendar.events.readonly`. Follow Google's
consent-screen/publishing requirements for the intended users.

Calendar import does not receive the client secret or a refresh token. The access token remains only
in page memory and is cleared on pagehide. Cernere login is not required to import.
All-day dates are interpreted as local calendar days, with Google's exclusive end
date. Timed events preserve their supplied UTC offset. Recurrences are expanded
by Google (`singleEvents=true`); pages are fetched until complete, capped at 2000
events to avoid silently publishing an incomplete result.

### One-time administrator setup (Calendar and Meet)

Create one Google OAuth **Web application** client, enable the Calendar and Meet
APIs, and configure its consent screen for the intended users. In that same client,
register Ae's exact JavaScript origin and its `/api/meet/oauth/callback` redirect URI.
Register the exact GLab callback URI from `AEDILIS_MEET_GLAB_REDIRECT_URIS` as well
when GLab embeds Ae. The two callback paths remain distinct, but use one client.

Store `AEDILIS_GOOGLE_CLIENT_ID` and `AEDILIS_GOOGLE_CLIENT_SECRET` once in Ex Vault
and bind them to `aedilis`. Both integrations read `server/lib/google-oauth-config.ts`;
only the public client ID is sent to the Calendar browser configuration. Never put
the client secret into JSON settings, browser storage, source control or chat.
The same persistent binding supplies subsequent restarts and deployments.

This operator setup is separate from each user's Google consent. Calendar import
keeps its page-memory token model; Meet retains its existing Cernere token storage
and refresh flow. Revoked or expired authorization can still require consent again.
No automatic account sharing or expansion of scopes is introduced.

Reference: https://developers.google.com/identity/protocols/oauth2/web-server

## Cernere registration and ownership

Use the existing `CERNERE_BASE_URL`, `AEDILIS_PUBLIC_URL` and launch credentials.
Set `AEDILIS_CERNERE_PUBLIC_URL` (or `cernerePublicUrl` in settings.json) to the
browser-accessible Cernere origin. The Excubitor-injected backend URL is not
assumed to be reachable from the user's browser. Until this is configured, the
login button visibly reports setup pending rather than opening an internal URL.
The public origin must be in Cernere's composite allowed-origin list and the
`aedilis` managed project must be active. A popup handles login/registration;
its origin and Window source are checked before the authCode is exchanged.
The service obtains an `aedilis` project PASETO for its exact public audience and
stores it in an HttpOnly cookie for at most 15 minutes. Reauthenticate on expiry.
Access/refresh tokens from the one-time exchange are not persisted.

Linking is explicit and proves both cookie possession and Cernere identity.
It revokes the old anonymous device capability. Later account changes do not
inherit a prior account's answers. A lost anonymous cookie cannot be recovered
by submitting the same display name. Cookie loss before linking loses ownership.

## Discord

Conexus currently contains only a README, so this implementation uses Discord's
documented REST API directly with an Aedilis bot credential. It does not reuse
another service's bot token or a channel webhook.

1. In Cernere, an administrator grants `identity_claims: ["discord_id"]` to
   Aedilis. The service cannot grant itself this permission.
2. Users link Discord to their Cernere account and opt in on the meeting page.
3. Bind `AEDILIS_DISCORD_BOT_TOKEN` in Excubitor Vault for startup injection; set
   `AEDILIS_DISCORD_ENABLED=true` or `discordEnabled=true` in settings.json.
   Enabled without a credential fails startup explicitly. Disabled is visible in UI.
4. The bot must be able to open a DM to the linked user; privacy restrictions can
   still reject delivery. Users can inspect failed deliveries and request retry.

Answer changes notify the linked organizer; meeting changes/finalization and
cancellation notify linked participants. Self notifications and duplicate users
are suppressed. Only a generic event description and meeting link are sent.
No response names/comments or agenda text are put in Discord messages.
Outbox rows commit atomically with edits. Retry is bounded; expired leases resume
after restart. Discord nonce deduplication is time-limited, so the protocol is
at-least-once: an ambiguous send followed by a long outage may deliver a duplicate.
Successful delivery records the Discord message ID; queued is not delivered.

## Security and operations

Set AEDILIS_PUBLIC_URL to the exact browser origin used through Excubitor/Tunnel;
mutation origins must match. HTTPS enables Secure cookies. SameSite, HttpOnly,
origin validation, JSON-only mutation bodies, body limits and bounded in-memory
rate limiting protect the public surface. A reverse proxy may collapse client IPs;
the per-connection-address limit then applies to that proxy as a whole.
Meeting pages must be reachable without a mandatory login wall for anonymous use.
The operator owns public exposure and credentials; this change does not alter DNS,
Cloudflare Access, Cernere admin settings, or live service configuration.

User-approved scope permits implementation only. Tests, live OAuth/Discord
checks, startup/restart, deployment and merge remain unexecuted.
