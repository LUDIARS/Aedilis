// /api/me — フロントエンドが自分の identity と admin 権限を確認する endpoint。

import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { getIdentity, requireAuth } from '../auth.ts';
import { upsertUserDisplay } from '../db.ts';

export function makeMeRouter(db: Database.Database): Hono {
  const r = new Hono();
  r.get('/', requireAuth, (c) => {
    const id = getIdentity(c);
    // display name を Cernere 由来で受け取ったらキャッシュ更新 (他人の予約表示用)
    if (id.displayName) upsertUserDisplay(db, id.userId, id.displayName);
    return c.json({
      userId: id.userId,
      displayName: id.displayName,
      role: id.role,
      isAdmin: id.isAdmin,
    });
  });
  return r;
}
