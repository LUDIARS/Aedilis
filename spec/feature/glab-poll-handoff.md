# SPEC-AE-GLAB-HANDOFF-01

Approved by neco, 2026-10-18: guest answers only; finalized polls become GLAB events;
attendance and absence require login; 「この内容で開始」.

The signed GLAB-only POST `/api/meetings/:id/glab-event/finalize` accepts slotId/revision.
It verifies the organizer, requires public visibility, finalizes and reserves the facility,
and stores an immutable snapshot in the same transaction. Retrying the same slot returns
the snapshot without another reservation. A different slot or cancelled poll is rejected.
GLAB persists one event per meeting ID and reuses this reservation instead of creating one.

Handed-off polls cannot be edited or independently cancelled in Ae. GLAB cancels through
the signed `/glab-event/cancel` endpoint, which cancels the poll and releases its reservation
idempotently. The snapshot remains as a tombstone. Anonymous response ownership is unchanged;
names are never used to infer attendance identities. Internal/private polls are not exported.

SQLite and PostgreSQL receive the additive handoff table; site transfer includes it.
Live migrations, tests and service restarts are not performed by this implementation session.
