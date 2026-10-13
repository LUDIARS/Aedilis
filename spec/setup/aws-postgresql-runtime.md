# AWS PostgreSQL runtime and ae-aws publication

## SPEC-AEDILIS-PG-RUNTIME

Human instruction: neco, 2026-10-14: AWSのAeをAWSのPostgress見るようにして、
ae-awsでCF設定して公開。

The prior no-stop instruction remains applicable to HQ Ae and to the completed
data-only copy. This change prepares an explicit AWS-only backend selection and
public origin. Do not imply that a source snapshot is ongoing replication.
Do not restart HQ or replace the existing ae hostname.

Supporting domain `persistence` supplies async SQL execution and transaction
lifetime. Core domain `facility-reservation` retains half-open overlap detection
and administrator-owned allow_overlap. `meeting-scheduling` retains ownership,
optimistic revisions, guest policies and atomic meeting/facility linkage.
Identity data still belongs to Cernere. No other repository is changed.

## Backend contract

HQ/default backend is `AEDILIS_DB_BACKEND=sqlite`. AWS explicitly selects
`postgres` and receives `AEDILIS_DATABASE_URL` through its existing Ex Vault site
override. No app dotenv, Vault access, or secret retrieval is introduced. The
approved target is loopback PostgreSQL, DB `aedilis`, role `aedilis_app`; any
invalid setting or missing transfer/schema fails before serving. SQL placeholders
are converted outside quoted literals/comments. PostgreSQL 64-bit integers are
decoded only if exactly representable by the existing numeric domain interfaces.

PostgreSQL schema is verified against a disposable in-memory instance of the
service-owned SQLite schema. All required columns/types and a committed transfer
receipt must exist. PG startup never falls back to SQLite, creates an empty DB,
overwrites rows or re-runs source-only SQLite DDL. Future schema changes need an
approved additive PostgreSQL migration. Existing source/import hooks are for the
HQ SQLite → PostgreSQL transfer direction, not ongoing PG backups or replication.

All domain calls await the same execution facade. SQLite transactions use a
connection queue and BEGIN IMMEDIATE across awaits; unrelated requests cannot
enter a live transaction. PG transactions pin a pool client, use a bounded
service-wide advisory lock for all writes/booking reads requiring consistency,
and release/rollback on every path. Statement savepoints allow duplicate handling
without aborting the entire transaction; nested units retain rollback boundaries.
Sensitive PG error details are replaced with categorical compatibility codes.

Reservation create/update recheck overlap under the transaction lock, including
the latest administrator overlap policy. Meeting revision checks and writes stay
inside one transaction. Visibility filtering and rendering of reservation lists
and meeting details share the same transaction to avoid asynchronous policy races.
The pool is bounded (4 clients), time-limited, and closed during service shutdown.
Production remains compiled Node without tsx, watchers or child workers.

## Data provenance and cutover

The prepared AWS DB contains the verified HQ snapshot from 2026-10-13
23:59:23.685 JST: 18 tables, 75 rows. Original SQLite remains intact; transfers and
the committed PostgreSQL receipt remain available for rollback/audit. After that
snapshot, HQ additions/edits are not synchronized. This instruction exposes the
AWS copy at a new hostname; it does not authorize replacing the original public
hostname, deleting HQ data, or overwriting the occupied PostgreSQL database.
Browser cookies are host scoped; copying salted ownership records does not copy
browser cookies to a new hostname. Real user ownership/login verification remains
separate from public HTTP/configuration checks.

## Cloudflare plan and current block

Interpret requested `ae-aws` as `ae-aws.ai-run-do.com`, pending account/zone readback
using the existing CF tool. Verify the chosen existing tunnel's connector runs on
AWS, or that its actual connector host reaches the AWS origin. Target port comes
from Ae's owned catalog (17502 at preparation), not a remembered service map.
Access is required because Ae can expose/control personal/private booking data.
Read existing policy and confirm intended users; do not reuse another project's
ALLOW ME or select Everyone/Bypass. Create/read back Access+policy before protected
Tunnel route and proxied DNS. Preserve all unrelated routes/apps/records.

The existing approved Infisical credential endpoint returned HTTP 530 / Cloudflare
1033 on 2026-10-14. No CF write was attempted. Do not switch authentication
identity/origin or alter unrelated services to evade that failure. Actual CF
account/zone/tunnel/policy/DNS and permitted users remain unverified.

## Validation

Registered SQLite domain assertions are preserved with awaits and async rejection
assertions. New tests cover transaction isolation across awaits, rollback/nested
rollback and queue reuse, SQL quoting/comment placeholders, missing/wrong backend
configuration, pinned PG client, categorical errors/savepoint recovery and cleanup.
PG protocol unit tests mock the connection boundary; they are not real-server
integration evidence. Session does not run the registered suite; Revisor owns it.
Required typecheck and compiled server/web build passed at preparation.
Actual AWS startup, PG-backed responses, public DNS/Access and authenticated UX
are pending. An deterministic `plan` returned persistence/facility-reservation/
meeting-scheduling; absent program-layer/content-source files were reported.

Primary library/SQL references: [node-postgres transactions](https://node-postgres.com/features/transactions),
[PostgreSQL advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS).
