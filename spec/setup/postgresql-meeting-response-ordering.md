# PostgreSQL meeting response ordering {#SPEC-PG-MEETING-RESPONSE-ORDERING}

An existing meeting with migrated responses must remain readable on PostgreSQL.
SQLite implicitly exposes rowid, but the PostgreSQL response schema has only its
explicit columns. MeetingRepository.responses chooses SQLite rowid for existing
HQ insertion ordering and the response UUID id for stable PostgreSQL ordering.
Neither choice is supplied by a request. Response records, ownership, visibility,
and schema remain unchanged; no repeated data import is needed.

The regression test exercises the repository through the PostgreSQL query
boundary, rejecting an implicit SQLite column and checking that answers remain
scoped to their meeting. It mocks the driver, not a real PostgreSQL server.
Typecheck/build are required; registered tests run through Revisor. After merge,
verify the real AWS meeting API and existing response count without printing
private meeting contents. HQ/AWS equality can be checked using canonical row
digests, disregarding response display order.
