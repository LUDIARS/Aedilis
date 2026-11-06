# Scoped GLAB managed Google Meet target

ID: SPEC-AE-GLAB-MANAGED-MEET-DELEGATION-001

This bounded consumer migration exposes six existing managed Meet shapes at
`/api/integrations/glab/meet`. It adds no meeting/provider feature or OAuth scope.
Cr parent e0acdef1, GLAB source681667b9 and Ae target21f8c3dc track the distinct
remaining work. Google configuration activation and direct PWA login are not
completed by this target change.

| Method/path suffix | Exact Cr action | Risk |
| --- | --- | --- |
| GET /status | meet.status.read | sensitive_read |
| POST /oauth/start | meet.oauth.start | important |
| POST /oauth/complete | meet.oauth.complete | important |
| GET /meeting-UUID | meet.read | sensitive_read |
| POST /meeting-UUID | meet.create | important |
| POST /external/glab-event/positive-event-id | meet.external.create | important |

Other paths/methods, direct OAuth callbacks, external GET and unknown identifiers
are refused before consumption. The existing Composite SDK consumes exactly one
proof bound to source glab, target aedilis, same user, action, risk, actual method,
path plus query, captured bytes and signed booking-context header. GET has zero
body; writes have an 8192-byte limit. Legacy Bearer/global/cookie credentials are
never accepted in this namespace. Existing vendored SDK remains unchanged.

The request-owned execution scope is a private WeakMap installed only inside
SDK execute and removed in finally. Its timer and abort listener are always
released. The shared managed router trusts this scope, not a client header or
an arbitrary prepopulated identity. Its original direct authentication remains
in force on direct requests. Both mounts borrow one provisioning owner with
one active set, so simultaneous old/new requests cannot create competing spaces.

Every guard checks request cancellation, proof deadline, same authenticated user,
exact signed booking bytes and current registered identities. A meeting request
also checks current audience; creation additionally requires current ownership,
online enabled and not cancelled. OAuth preserves the existing same-user,
same-source, exact allowlisted redirect, expiring one-use state and PKCE; current
signed organization-representative or Ae administrator rights remain necessary
for organizer linkage. The GLAB source owns external event visibility/owner ACL;
the target accepts only the verified GLAB event namespace and signed groups.

No DB transaction is held across Google HTTP. Check current resource/deadline
immediately before each new Google dispatch, state/token/organizer write and
success disclosure. Per-request Google calls combine cancellation/deadline with
the existing 15-second transport timeout and reject redirects. Token refresh
remains a shared account-owned operation; one caller cannot cancel another
caller's refresh or lose refresh-token rotation bookkeeping.

Cr consumption, local writes and Google effects are not one distributed
transaction. A call already dispatched may complete while authority changes.
Persist its returned space identifier or uncertain creation status to avoid
duplicate creation, even if the client ended; then refuse further dispatch or
success disclosure. Never automatically retry an unknown creation result.
Existing member-list recovery occurs only on a new valid operation against the
same persisted space. A partially configured link stays hidden.

Network destinations and scopes are unchanged: configured Cr managed-project
storage/backchannel, accounts.google.com authorization URL,
oauth2.googleapis.com token exchange, openidconnect.googleapis.com verified
userinfo and meet.googleapis.com v2 spaces/members. Credentials stay in server
config/memory and existing Cr OAuth storage, never response/log/DB space rows.
No new dependency, install script, indirect dependency, telemetry or startup
communication is introduced. Existing service owners start nothing here.

Acceptance requires the existing and added registered Revisor test suite, strict
backend/test/frontend type checks and reviewed-to-published full tree equality.
Implementation agents do not run tests. GLAB callback/query binding and six
target caller mappings, Cr action/risk/consent registration, Google redirect and
credentials, service configuration, canonical host adoption, real provider
verification and coordinated all-consumer cutover remain unfinished. No deploy.
