import type { Hono } from 'hono';
import { bookingPrincipal } from '../booking-access/request.ts';
import { readAudience } from '../booking-access/policy.ts';
import { prepare, transaction, type DatabaseInput } from '../persistence/database.ts';
import { actorFor } from './identity.ts';
import { linkedReservation } from './facility-reservation.ts';
import { glabHandoff } from './glab-handoff-state.ts';
import { MeetingRepository } from './repository.ts';
import { MeetingError, type Actor, type Candidate, type Venue } from './types.ts';
import { object, revision, text } from './validation.ts';

export interface GlabMeetingSnapshot {
  meetingId: string; title: string; description: string; createdBy: string;
  slot: Candidate; facilityId: string | null; reservationId: string | null;
}

/** Finalization and reservation ownership freeze in one Ae transaction; GLAB can retry the same handoff. */
export async function finalizeForGlab(db: DatabaseInput, id: string, slotId: string,
  expected: number, actor: Actor): Promise<GlabMeetingSnapshot> {
  return transaction(db, async () => {
    const repo = new MeetingRepository(db);
    let row = await repo.get(id);
    repo.requireOwner(row, actor);
    if (!actor.userId) throw new MeetingError(401, 'ログインしてください');
    if (row.state === 'cancelled') throw new MeetingError(409, '中止済みの会議です');
    const saved = await glabHandoff(db, id);
    if (saved) {
      const snapshot = JSON.parse(saved) as GlabMeetingSnapshot;
      if (snapshot.slot.id !== slotId) throw new MeetingError(409, '別の日程でGLABの予定に確定済みです');
      return snapshot;
    }
    // GLAB's event role model cannot preserve private/team visibility. Never silently widen it.
    if ((await readAudience(db, 'meeting', id)).visibility !== 'public') {
      throw new MeetingError(400, 'GLABの予定へ確定する調査は公開範囲をPublicにしてください');
    }
    repo.requireRevision(row.revision, expected);
    if (row.state !== 'finalized' || row.selected_slot !== slotId) {
      await repo.finalize(id, slotId, expected, actor);
      row = await repo.get(id);
    }
    const slot = (JSON.parse(row.slots_json) as Candidate[]).find(candidate => candidate.id === row.selected_slot);
    if (!slot) throw new MeetingError(409, '確定した候補が見つかりません');
    const venue = (JSON.parse(row.venues_json) as Venue[]).find(candidate => candidate.name === slot.venue);
    const snapshot: GlabMeetingSnapshot = { meetingId: id, title: row.title, description: row.description,
      createdBy: actor.userId, slot, facilityId: venue?.facilityId ?? null,
      reservationId: venue?.facilityId ? await linkedReservation(db, id) : null };
    if (snapshot.facilityId && !snapshot.reservationId) throw new MeetingError(409, '施設予約が確認できません');
    await prepare(db, 'INSERT INTO meeting_glab_handoff(meeting_id,snapshot_json) VALUES(?,?)').run(id, JSON.stringify(snapshot));
    return snapshot;
  })();
}

export function registerGlabHandoff(app: Hono, db: DatabaseInput): void {
  app.use('/:id/glab-event/*', async (c, next) => {
    if ((await bookingPrincipal(c)).source !== 'glab') throw new MeetingError(403, 'GLABから操作してください');
    await next();
  });
  app.post('/:id/glab-event/finalize', async c => {
    const body = object(await c.req.json());
    return c.json(await finalizeForGlab(db, c.req.param('id'), text(body.slotId, 64, true),
      revision(body.revision), await actorFor(db, c)));
  });
  app.post('/:id/glab-event/cancel', async c => {
    const id = c.req.param('id'), actor = await actorFor(db, c);
    await transaction(db, async () => {
      const repo = new MeetingRepository(db), row = await repo.get(id);
      repo.requireOwner(row, actor);
      if (!await glabHandoff(db, id)) throw new MeetingError(409, 'GLABへの引き継ぎがありません');
      if (row.state !== 'cancelled') await repo.cancel(id, row.revision, actor, true);
    })();
    return c.json({ ok: true });
  });
}
