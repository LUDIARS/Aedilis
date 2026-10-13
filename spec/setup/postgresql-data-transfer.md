# Aedilis HQ data → AWS PostgreSQL

## SPEC-AEDILIS-PG-TRANSFER

Instruction: neco, 2026-10-13: 本社のAeのデータを、AWSのポスグレにデータ移行する。

Value: preserve Ae reservation and meeting ownership/content in the approved AWS
destination. Domain: persistence (supporting domain); existing facility-reservation,
meeting-scheduling and attendance-checkin domains own their business invariants.
No unrelated repository, authentication service DB or public routing changes.

The current main revision bd07788 uses SQLite and contains 18 tables. HQ read-only
inventory found 4 facilities, 1 reservation, 1 display cache, 29 meeting identities,
29 salted browser ownership records, 3 meetings and 8 responses. These counts are
preparation evidence, not a final migration snapshot. AWS PostgreSQL 17 has no
`aedilis` database at initial inspection. A new empty `aedilis` database and its
dedicated `aedilis_app` owner have now been provisioned; role metadata confirms
no superuser or database-creation privileges. No existing schema/authentication
configuration was changed. A generated future app connection secret was saved
only to AWS Ex Vault and is not bound to a service yet. The nonsecret import
config exists. AWS Ae still uses SQLite; no source rows have been transferred.

## Transfer contract and acceptance

Excubitor invokes stopped-service export/import hooks from the canonical checkout.
Export reads the SQLite DB with fileMustExist/readonly, integrity and FK checks,
and one consistent transaction. A private, exclusive-created UTF-8 JSON artifact
contains service/version, column types/defaults/PKs, supported CHECK predicates,
foreign keys/delete-update actions, unique/partial indexes and typed rows.
Unknown tables, types, predicates and expression indexes fail closed.

`INTEGER` maps to PostgreSQL BIGINT with decimal-string serialization to avoid
JavaScript precision loss. TEXT remains TEXT (including JSON strings); REAL maps
to DOUBLE PRECISION. The JSON-valid CHECK becomes a JSONB cast validation without
rewriting stored text. Primary keys, uniqueness and foreign keys are retained.

Artifacts contain personal data and salted browser ownership hashes; they must
not be committed, attached to Discord, or printed. Those service-specific hashes
preserve existing guest ownership; no browser secret is stored in the artifact.
Nonempty site gateway registrations or OAuth authorization state fail rather than
copy site credentials. The observed source has neither. No environment variables,
Vault secrets, host IDs, process logs or machine credentials enter the artifact.

Taildrop transport to the approved AWS peer retains the source SHA-256. Import
accepts an absolute regular nonsymlink file up to 64 MiB and verifies its checksum,
service ID, version, schema and per-table row digests before connecting.
Current Ex bootstrap hooks inherit Ex's environment, not the service Vault
bindings; do not read Vault secrets from the application or pretend injection
exists. A site-owned **nonsecret** `.local/postgresql-transfer.json` explicitly
selects `{ "backend": "docker-psql", "container": "cernere-postgres" }` on the
verified AWS host. Import uses Docker exec's local PostgreSQL socket as the
dedicated `aedilis_app` role, not the cluster administrator. Existing local-socket
authentication must be verified; never weaken pg_hba or fall back to admin access.
SQL rechecks database `aedilis` and role `aedilis_app` before any schema changes.
Use a new least-privileged role owning only the new database; do not grant
superuser, role creation or database creation to the application role.

Within one transaction and an advisory lock, import rejects any occupied target,
creates dependency-ordered tables/indexes and inserts validated, safely quoted
typed row values with standard-conforming SQL strings enabled. One `psql` session
uses ON_ERROR_STOP, server statement/lock limits, and a container-side 110-second
deadline (a missing `timeout` executable fails). Verification runs **inside PostgreSQL**:
each count plus both directions of an EXCEPT ALL comparison of typed JSON row
arrays must match the checksum-verified source. This preserves duplicates and
does not depend on SQL collation/row ordering. Source row digests are written
only after exact equality succeeds. Deferred constraints precede receipt/COMMIT.
Failure rolls back all DDL/data. A committed receipt records artifact hash and
all verification digests. Unknown commit outcomes must be resolved by reading
this receipt, never blindly retrying. Existing targets are never overwritten.

## Execution and recovery

1. Merge/review the service-owned hooks. Deploy via Ex with start:false as needed.
2. Confirm the new isolated PostgreSQL DB/role and local-socket authentication;
   write the nonsecret AWS import configuration. Reserve any future app connection
   secret in AWS Ae's Ex Vault without exposing it in artifacts or logs.
3. Claim Ae maintenance; stop HQ Ae and AWS Ae through Ex. Do not launch worktrees.
4. Export via HQ Ex, retain operation ID/SHA-256, transfer via the common Taildrop tool.
5. Import via AWS Ex; confirm operation and committed receipt/table digests.
6. Retain the original SQLite DB, transfer artifact and any AWS SQLite data.
   Source restart, deletion and public routing cutover are separate decisions.

Import prepares PostgreSQL data. It does **not** make the existing SQLite-only
application read PostgreSQL. Application adapter/call-site conversion and its
review are necessary before PostgreSQL can be the live application data source.
Do not claim migration/cutover complete while that distinction is unresolved.

## Validation status

Added registered tests for lossless large integers/Unicode, FK/index/CHECK
preservation, corrupt content, SQL dialect rejection, sensitive site-state
rejection, SQL quoting/dollar-delimiter injection, target guard and commit ordering. Session
does not execute the registered suite; Revisor owns it. Real PostgreSQL import,
source snapshot, transfer and runtime cutover remain unexecuted at preparation.
Anatomia `plan --project aedilis --no-llm` was consulted; it returned existing
domains and noted absent program-layer/content-source definitions. Its nearest
domain ranking is guidance, not runtime verification. No Pf DB specification is
registered (project specs endpoint returned an empty list).

Primary references consulted: PostgreSQL 17 [numeric types](https://www.postgresql.org/docs/17/datatype-numeric.html)
and [constraints](https://www.postgresql.org/docs/17/ddl-constraints.html).
