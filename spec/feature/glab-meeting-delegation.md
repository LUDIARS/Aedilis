# Scoped GLAB meeting poll and handoff target

`SPEC-AE-GLAB-MEETING-DELEGATION-001`. Actio834eb0ef-adc2-4cf2-ae73-098d79ab290e,
Cr parent e0acdef1-32ef-40a8-bc38-be2250bed9cb, source GLAB681667b9.
This is the authentication boundary of existing meeting poll operations; the
previous direct-login4e6, handoff4614 and reservation-targetca454 tasks retain
their separate acceptance records.

## Finite target contract

Under `/api/integrations/glab/meetings`, require the real Composite SDK's one-use
grant from current source glab to target aedilis and a signed booking assertion.
All GET below are sensitive_read; every mutation is important.

| Method/path | action |
| --- | --- |
| GET collection | meetings.list.read |
| GET mine | meetings.mine.read |
| POST collection | meetings.create |
| GET :id | meetings.read |
| PATCH :id | meetings.update |
| DELETE :id | meetings.cancel |
| POST :id/finalize | meetings.finalize |
| POST :id/responses | meetings.response.create |
| PATCH :id/responses/:responseId | meetings.response.update |
| POST :id/glab-event/finalize | meetings.glab-event.finalize |
| POST :id/glab-event/cancel | meetings.glab-event.cancel |

Session/login/logout/link/notifications, anonymous/Discord capabilities, response
deletion, facilities, Google Meet and unknown method/path/HEAD are excluded.
Cookies and obsolete Bearer/global credentials are refused, so a guest identity
cannot be mixed into a delegated actor. Only current Cr-linked identities are
resolved for pre-execution ownership, followed by the original handlers' ACLs.

## Current resources and atomic outcome

The same SDK adapter and bounded-byte reader as the accepted reservation target
are reused without another verifier, credential format, signature or package.
The entire action/method/path/query/body/request ID/risk and signed booking header
are bound. Booking assertions use the existing server-owned HMAC verifier; its
independent subject/path/body/groups/expiry checks remain mandatory. Captured
bytes are decoded as strict UTF-8 for that existing string-based verifier while
the replay stream remains unread for the original body-limit and JSON parser.

The SDK consumes first, before opening a DB transaction. The current linked
actor, meeting audience/owner, and response owner are then checked inside the
same pinned SQLite/PostgreSQL transaction as the existing handler. Lists retain
per-row current audience checks. Owner mutations do not become administrator
mutations. Creation derives the registered actor from verified Cr identity.
The original revision checks, guest-response policy and GLAB handoff public-only
export/reservation freeze/idempotency rules are preserved.

Handled application errors retain their status/response but roll back the outer
transaction. Disconnect, expired capability or booking assertion after handler
execution also roll back all DB changes before commit. These selected operations
only use the existing DB and facility source; no Google/Discord delivery or other
irreversible external side effect is added within this transaction. Consume and
DB are not a distributed transaction; failed or unknown outcomes are not retried
using the consumed permission. Existing handoff idempotency permits a new
authorized request to retrieve the same committed snapshot, not reuse a proof.

Collection projection executes each nested view transaction sequentially on the
single pinned connection, retaining order and the explicit-audience directory
filter. Parallel nested SQLite SAVEPOINT lifetimes cannot be released out of
order. If Hono has already finalized a success response when the post-handler
deadline/disconnect guard fails, the gate explicitly replaces that response with
the failure; returning a second response alone is insufficient.

POST/PATCH and meeting DELETE accept at most64KiB for existing revision payloads;
GET accepts zero bytes. Reservation DELETE keeps its existing zero-byte limit.
Limits are route-owned and cannot be overridden by request fields. The existing
15-second capture deadline, memoized cancellation, awaited reader shutdown,
timer/listener cleanup and SDK owner shutdown apply. The already-created meeting
router is borrowed for both mounts and disposed exactly once by its existing
server owner.

## Verification and unfinished conditions

Contracts use the real standard SDK, Hono and in-memory SQLite, with only the
remote authority/connection metadata as fixtures. They cover actor/audience and
response-owner changes, successful owner mutation, exact DELETE bytes, one-use
replay rejection, handled validation error rollback, disconnect after handler
writes, and original handoff idempotency. The agent does not execute these tests;
registered Revisor runs them along with the existing direct/guest suites.

No new dependency, install hook, startup connection or communication destination
is introduced. The existing project credential and configured Cr backchannel
remain server-only; this is the unchanged small-body SDK protocol already
vendored by Aedilis. Actual administrator operation declarations, current consent,
source GLAB ten-route/action migration plus internal handoff cancellation,
explicit audience map, runtime verification and coordinated all-consumer cutover
remain incomplete. Google Meet, GPS and direct legacy PWA migration remain
separate work. Do not deploy independently or weaken the guest/login boundary.
