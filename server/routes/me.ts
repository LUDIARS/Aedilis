import { type DatabaseInput } from '../persistence/database.ts';
// /api/me — フロントエンドが自分の identity と admin 権限を確認する endpoint。
import { Hono } from 'hono';
import { getIdentity, requireAuth } from '../auth.ts';
import { upsertUserDisplay } from '../db.ts';
export function makeMeRouter(db: DatabaseInput): Hono {
    const r = new Hono();
    r.get('/', requireAuth, async (c) => {
        const id = getIdentity(c);
        // display name を Cernere 由来で受け取ったらキャッシュ更新 (他人の予約表示用)
        if (id.displayName)
            (await upsertUserDisplay(db, id.userId, id.displayName));
        return c.json({
            userId: id.userId,
            displayName: id.displayName,
            role: id.role,
            isAdmin: id.isAdmin,
        });
    });
    return r;
}
