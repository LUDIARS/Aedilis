import type Database from 'better-sqlite3';
import type { FacilitySource } from '../facility/source.ts';
import { publicFacilities, validateFacilities } from './facilities.ts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { CernereProjectClient } from '../lib/cernere-project-client.ts';
import { actorFor, ensureActor, linkActor } from './identity.ts';
import { beginLogin, completeLogin } from './cernere-login.ts';
import type { MeetingConfig } from './config.ts';
import { discordIdentity } from './discord.ts';
import { MeetingRepository } from './repository.ts';
import { MeetingError, type Candidate } from './types.ts';
import { meetingInput, object, responseInput, revision, text } from './validation.ts';

export function makeMeetingRouter(db: Database.Database, config: MeetingConfig, client: CernereProjectClient, facilities?: FacilitySource): Hono {
  const app = new Hono(), repo = new MeetingRepository(db);
  const origin = new URL(config.publicUrl).origin, secure = origin.startsWith('https:');
  const limits = new Map<string, { count: number; until: number }>();
  app.use('*', bodyLimit({ maxSize: 131072, onError: c => c.json({ error: '入力が大きすぎます' }, 413) }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('origin') !== origin || c.req.header('sec-fetch-site') === 'cross-site') throw new MeetingError(403, '同じサイトから操作してください');
      if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) throw new MeetingError(400, 'JSON形式で送信してください');
      const now = Date.now();
      for (const [key, value] of limits) if (value.until <= now) limits.delete(key);
      const address = getConnInfo(c).remote.address ?? 'unknown';
      if (!limits.has(address) && limits.size >= 10000) throw new MeetingError(429, '時間をおいて再度お試しください');
      const rate = limits.get(address) ?? { count: 0, until: now + 60000 };
      rate.count++; limits.set(address, rate);
      if (rate.count > 120) throw new MeetingError(429, '操作が多すぎます。1分後にお試しください');
    }
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof MeetingError) return c.json({ error: err.message }, err.status);
    if (err instanceof SyntaxError) return c.json({ error: '入力形式が不正です' }, 400);
    console.error('[meetings] request failed', err.name);
    return c.json({ error: '処理に失敗しました。再試行してください' }, 503);
  });
  app.get('/config', c => c.json({ googleClientId: config.googleClientId, discordEnabled: !!config.discordToken, cernereUrl: config.cernerePublicUrl }));
  app.get('/facilities', async c => {
    if (!facilities) throw new MeetingError(503, '施設一覧が設定されていません');
    return c.json({ items: await publicFacilities(facilities) });
  });
  app.post('/session', async c => {
    const actor = ensureActor(db, c, await actorFor(db, c), secure);
    return c.json({ linked: !!actor.userId, notifications: actor.identities.some(i => i.notify === 1) });
  });
  app.post('/session/login/start', c => c.json({ nonce: beginLogin(c, secure) }));
  app.post('/session/login/complete', async c => {
    await completeLogin(c, config, object(await c.req.json()));
    return c.json({ ok: true });
  });
  app.post('/session/link', async c => {
    const actor = await actorFor(db, c);
    linkActor(db, c, actor, secure);
    return c.json({ ok: true });
  });
  app.post('/session/logout', c => {
    deleteCookie(c, 'cernere_token', { path: '/', secure, httpOnly: true, sameSite: 'Lax' });
    return c.json({ ok: true });
  });
  app.post('/session/notifications', async c => {
    const actor = await actorFor(db, c), input = object(await c.req.json());
    if (!actor.userId) throw new MeetingError(401, 'Cernereにログインしてください');
    if (typeof input.enabled !== 'boolean') throw new MeetingError(400, '通知設定が不正です');
    if (input.enabled) {
      if (!config.discordToken) throw new MeetingError(503, 'Discord通知は管理者による設定待ちです');
      await discordIdentity(client, actor.userId);
    }
    db.prepare('UPDATE meeting_identity SET notify=? WHERE user_id=?').run(input.enabled ? 1 : 0, actor.userId);
    return c.json({ ok: true });
  });
  app.get('/session/notifications', async c => {
    const actor = await actorFor(db, c);
    if (!actor.userId) throw new MeetingError(401, 'Cernereにログインしてください');
    const items = db.prepare(`SELECT o.id,o.event,o.status,o.attempts,o.last_error AS error FROM meeting_outbox o
      JOIN meeting_identity i ON i.id=o.recipient_id WHERE i.user_id=? ORDER BY o.created_at DESC LIMIT 20`).all(actor.userId);
    return c.json({ items });
  });
  app.post('/session/notifications/retry', async c => {
    const actor = await actorFor(db, c);
    if (!actor.userId) throw new MeetingError(401, 'Cernereにログインしてください');
    if (!config.discordToken) throw new MeetingError(503, 'Discord通知は管理者による設定待ちです');
    await discordIdentity(client, actor.userId);
    db.prepare(`UPDATE meeting_outbox SET status='pending',attempts=0,due_at=?,last_error=NULL WHERE status='failed'
      AND recipient_id IN (SELECT id FROM meeting_identity WHERE user_id=? AND notify=1)`).run(Date.now(), actor.userId);
    return c.json({ ok: true });
  });
  app.get('/mine', async c => {
    const actor = await actorFor(db, c);
    const items = new Map<string, unknown>();
    for (const identity of actor.identities) {
      const rows = db.prepare(`SELECT DISTINCT p.id,p.title,p.state,p.updated_at FROM meeting_poll p
        LEFT JOIN meeting_response r ON r.meeting_id=p.id WHERE p.owner_id=? OR r.owner_id=? ORDER BY p.updated_at DESC LIMIT 100`).all(identity.id, identity.id) as { id: string }[];
      for (const row of rows) items.set(row.id, row);
    }
    return c.json({ items: [...items.values()] });
  });
  app.post('/', async c => {
    const input = await validateFacilities(meetingInput(await c.req.json()), facilities);
    const actor = await actorFor(db, c);
    const id = repo.create(input, actor);
    return c.json({ id }, 201);
  });
  app.get('/:id', async c => c.json(repo.view(c.req.param('id'), await actorFor(db, c))));
  app.patch('/:id', async c => {
    const body = object(await c.req.json());
    repo.update(c.req.param('id'), await validateFacilities(meetingInput(body), facilities), revision(body.revision), await actorFor(db, c));
    return c.json({ ok: true });
  });
  app.post('/:id/finalize', async c => {
    const body = object(await c.req.json());
    repo.finalize(c.req.param('id'), text(body.slotId, 64, true), revision(body.revision), await actorFor(db, c));
    return c.json({ ok: true });
  });
  app.delete('/:id', async c => {
    const body = object(await c.req.json());
    repo.cancel(c.req.param('id'), revision(body.revision), await actorFor(db, c));
    return c.json({ ok: true });
  });
  app.post('/:id/responses', async c => {
    const id = c.req.param('id'), body = object(await c.req.json()), row = repo.get(id);
    repo.saveResponse(id, responseInput(body, JSON.parse(row.slots_json) as Candidate[]), null, null, revision(body.meetingRevision), await actorFor(db, c));
    return c.json({ ok: true }, 201);
  });
  app.patch('/:id/responses/:responseId', async c => {
    const id = c.req.param('id'), body = object(await c.req.json()), row = repo.get(id);
    repo.saveResponse(id, responseInput(body, JSON.parse(row.slots_json) as Candidate[]), c.req.param('responseId'), revision(body.revision), revision(body.meetingRevision), await actorFor(db, c));
    return c.json({ ok: true });
  });
  app.delete('/:id/responses/:responseId', async c => {
    const body = object(await c.req.json());
    repo.deleteResponse(c.req.param('id'), c.req.param('responseId'), revision(body.revision), await actorFor(db, c));
    return c.json({ ok: true });
  });
  return app;
}
