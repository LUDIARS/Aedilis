# Anonymous meeting scheduling

Approval: neco, 2026-09-23, conversation response 「この内容で開始」.

## SPEC-AE-MEETING-01: Experience and acceptance

An organizer creates a meeting without login, lists candidate start/end times and
venues with availability, and shares its unguessable URL. Participants enter a
meeting-specific display name, yes/maybe/no per candidate, comment and optional
discussion topic. Only the holder of the generated browser credential may edit
or delete their response. Organizers may edit the meeting and select a final
candidate; candidate collection does not silently reserve a managed facility.

Cernere login/registration is optional. Explicit linking associates the proven
anonymous identity with the authenticated Cernere subject. Other authenticated
devices can then edit the same records. Names are meeting submissions, not a
second authoritative account profile. This anonymous ownership is the explicit
exception requested to the previous Cernere-only reservation design.

Google Calendar import uses Google Identity Services' browser token model with
read-only scopes, no refresh token or server token persistence. The organizer
selects events before importing candidate slots or venue busy periods. Import is
a snapshot, not calendar synchronization. Calendar details remain in the browser
until the organizer explicitly publishes selected fields.

Discord notifications: answer create/update/delete to linked organizer; meeting
change/finalization/cancellation to linked participants who opted in. Cernere is
the source of Discord identity, read through managed_project.get_identity_claims.
An outbox is committed with changes and retried with bounded backoff. Delivery
failure is distinct from saving a response. No live messages during development.

## Architecture and data

Existing Hono / SQLite / vanilla TypeScript remain. New meeting modules separate
validation, schema, identity, repository, HTTP routes and notification delivery.
Existing facility reservation authorization stays intact. Cookie capability is
32 random bytes, HttpOnly, SameSite=Lax, Secure on HTTPS; only its salted hash is
persisted. Mutations require the configured same origin and JSON. Cernere token
exchange uses the existing project audience and project key; auth codes are
received only from the opened Cernere popup. Credentials never appear in URLs.
Anonymous capability is revoked on account linking; Cernere login is thereafter
required for that linked identity. Editing uses revisions to reject lost updates.

New additive tables: meeting_identity, meeting_device, meeting_poll,
meeting_response, meeting_outbox. User IDs, identity hashes and notification
recipients are never included in public meeting responses. Public data is scoped
to the random meeting URL. Cookie loss before linking loses edit access.

## Evidence and validation

Base: Aedilis main 5aeaa9c. Existing auth.ts, db.ts and cernere-project-client.ts
were inspected; Anatomia plan/context for registered project aedilis consulted.
Calendar synchronization in spec/feature/calendar-sync.md is a plan, not an
existing implementation. New integration configuration must be supplied by the
operator (Google client ID/origin, Cernere allowed origin and discord_id claim,
Discord bot credential); missing configuration is visible, never simulated.

Tests, service start/restart, deploy, merge and main updates are not authorized.
Type checking and bundle compilation are static verification only. Acceptance
cases to execute when authorized: two anonymous browsers cannot change each
other's answers; cookie revisit; account link and cross-device edit; stale
revision; rejected cross-origin mutation; Google consent denial/pagination;
notification retry, process restart and disabled DMs.

External contracts:
- https://developers.google.com/identity/oauth2/web/guides/use-token-model
- https://developers.google.com/workspace/calendar/api/v3/reference/events/list
- https://docs.discord.com/developers/resources/user#create-dm
- https://docs.discord.com/developers/resources/message#create-message
