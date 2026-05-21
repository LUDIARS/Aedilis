// /api/facilities — 施設一覧 / 詳細 + admin の重複可フラグ切替。
//
// 施設の中身は FacilitySource が権威。 allow_overlap だけは facility_cache が
// 権威 (admin がトグルできるため)。 一覧表示時に source の最新を cache へ同期する。

import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { requireAdmin, requireAuth } from '../auth.ts';
import { getFacilityCache, setFacilityOverlap, upsertFacilityCache } from '../db.ts';
import type { Facility, FacilitySource } from '../facility/source.ts';

interface FacilityView extends Facility {
  /** facility_cache が権威の値 (admin トグル反映後)。 */
  allowOverlap: boolean;
}

/** source の施設を cache へ同期しつつ、 allow_overlap は cache の値を採用する。 */
function syncAndView(
  db: Database.Database,
  source: FacilitySource,
  facility: Facility,
): FacilityView {
  upsertFacilityCache(db, {
    facilityId: facility.id,
    displayName: facility.name,
    source: source.sourceName,
    allowOverlap: facility.allowOverlap === true,
    rawJson: JSON.stringify(facility),
  });
  const cached = getFacilityCache(db, facility.id);
  return { ...facility, allowOverlap: (cached?.allow_overlap ?? 0) === 1 };
}

export function makeFacilityRouter(
  db: Database.Database,
  source: FacilitySource,
): Hono {
  const r = new Hono();

  // 施設一覧
  r.get('/', requireAuth, async (c) => {
    const facilities = await source.listFacilities();
    const items = facilities.map((f) => syncAndView(db, source, f));
    return c.json({ items });
  });

  // 施設詳細
  r.get('/:id', requireAuth, async (c) => {
    const facility = await source.getFacility(c.req.param('id'));
    if (!facility) return c.json({ error: 'facility_not_found' }, 404);
    return c.json({ facility: syncAndView(db, source, facility) });
  });

  // admin: 重複可フラグ切替
  r.post('/:id/overlap', requireAuth, requireAdmin, async (c) => {
    const id = c.req.param('id');
    const facility = await source.getFacility(id);
    if (!facility) return c.json({ error: 'facility_not_found' }, 404);
    const body = (await c.req.json().catch(() => null)) as
      | { allowOverlap?: boolean }
      | null;
    if (!body || typeof body.allowOverlap !== 'boolean') {
      return c.json({ error: 'bad_request', code: 'allowOverlap required' }, 400);
    }
    // cache 行が無ければ作ってから設定
    syncAndView(db, source, facility);
    setFacilityOverlap(db, id, body.allowOverlap);
    return c.json({ facility: syncAndView(db, source, facility) });
  });

  return r;
}
