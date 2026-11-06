# GLAB scoped facility and reservation target

`SPEC-AE-GLAB-RESERVATION-DELEGATION-001`. Implementation task
actio:ca454759-08f6-4c72-88b1-f448e87bf05d, parent Cr
actio:e0acdef1-32ef-40a8-bc38-be2250bed9cb and GLAB source
actio:681667b9-144a-47b6-857e-72b9e5fec82e.

## Scope and current evidence

The current Aedilis f7ea5d9 source owns facilities, reservations, and booking
audience/ownership policy. Pf has the Aedilis project but no specifications;
Anatomia plan/context identified facility-reservation and booking-access.
The existing meeting-login, meeting-to-GLAB handoff and environment tasks are
separate requirements. This change adds no booking feature or public guest role.

The GLAB caller declaration includes GET reservation/:id, but Aedilis currently
has no corresponding handler. Earlier inventory of nine existing operations was
incorrect. That route remains unclassified and unsupported, not an empty success.
The following eight existing operation shapes are accepted only under
`/api/integrations/glab`:

| Method/path | action | risk |
| --- | --- | --- |
| GET facilities | facility.list | read |
| GET facilities/:id | facility.read | read |
| GET reservations/capabilities | reservation.capabilities | read |
| GET reservations | reservations.list | sensitive_read |
| GET reservations/mine | reservations.own | sensitive_read |
| POST reservations | reservations.create | important |
| PATCH reservations/:id | reservations.update | important |
| DELETE reservations/:id | reservations.delete | important |

No other method/path is inferred. HEAD, public exports, overlap administration,
meeting routes and unknown reservation identifiers do not bypass this gate.

## Authorization and resource lifetime

The accepted backend Composite SDK already vendored by Aedilis at b2bc69cf is
reused for the unchanged small-body delegation protocol. The current Cr71d
authority remains the source of project authentication, current revocation and
consent decisions. No SDK artifact, package, lockfile, signature scheme or global
user credential is introduced here. The existing source-lock records the actual
vendored revision; this unit does not claim it is the later bounded-upload SDK.

The service authenticates itself, consumes exactly one opaque capability, and
requires source glab, target aedilis, a nonempty verified user, the route-owned
risk, action, request ID, method, full path/query, exact body and semantic headers.
Reservation operations bind x-glab-booking-context in the SDK header digest;
capabilities/facility reads do not use that additional header. Its existing HMAC
verification still binds the independent verified user, method/path/body,
current expiry and server-configured key. It cannot choose a credential or issuer.
No old Bearer/global token/cookie is accepted in this namespace.

The real shared DB handlers receive strict authentication injection; they do not
chain legacy authentication. Resource access still checks current public,
internal-group or private/owner policy. Updates require the owner; cancellation
uses the target's configured admin IDs, never a role supplied in the body.
Creation derives owner from the verified subject. Mutation transactions repeat
current owner/audience and signed-context validation, and check disconnect and
capability deadline immediately before DB dispatch. Post-read disclosure checks
also reject ended requests. Facility cache synchronization checks before writing
after external source reads. Permit consumption and DB work are not a distributed
transaction; a consumed permission is not reused and an unknown result is not
automatically retried.

Bodies are captured once before parsing: POST/PATCH max64KiB, other methods
zero bytes, deadline15seconds. The exact bytes are replayed to the existing
parser. Cancellation is memoized and awaited; the owner clears timer/listener
and releases the reader on every path. The router borrows DB/source/SDK, and the
server that creates the SDK disposes it during its existing shutdown sequence.

## Communications, configuration and unfinished acceptance

Only existing server configuration selects CERNERE_BASE_URL and project
credentials. The new SDK owner constructs no startup connection. User operations
use Cr project authentication and `/api/auth/service/consume-delegation`; credentials
stay in the owner and are never returned. There is no new telemetry, installation
hook, network destination or indirect dependency. Existing facility sources,
public-key refresh and project-WS/outbox lifetimes remain separately owned.

GLAB must switch the corresponding seven source routes plus the internal
capabilities check to this namespace/action contract, sign the exact outgoing
path, and apply its latest admission/resource policy. Cr administrator hub_url,
composite_origins, service_operations/current consent and the explicit Corpus
audience map must be set together. Those actual settings have not been changed.
Meetings/Meet/GPS, direct legacy PWA and missing reservation-detail GET are
separate unfinished conditions. No independent deployment or service restart is
authorized. Tests execute only through the registered Revisor suite; source/type
checks, reviewed/public tree equality, runtime verification and coordinated
cutover are separate acceptance evidence.
