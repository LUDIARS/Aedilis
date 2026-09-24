import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type Database from 'better-sqlite3';
import { requireAuth, getIdentity } from '../auth.ts';
import type { CernereProjectClient } from '../lib/cernere-project-client.ts';
import { actorFor } from '../meetings/identity.ts';
import { MeetingRepository } from '../meetings/repository.ts';
import { MeetingError } from '../meetings/types.ts';
import { object } from '../meetings/validation.ts';
import type { MeetConfig } from './config.ts';
import { MeetTokens } from './tokens.ts';
import { MeetOAuth } from './oauth.ts';
import { MeetApi } from './api.ts';
import { MeetProvisioner } from './provision.ts';

export function managedMeetRoutes(db: Database.Database, client: CernereProjectClient, config: MeetConfig): Hono {
  const app = new Hono(), tokens = new MeetTokens(client, config), oauth = new MeetOAuth(db, config, tokens);
  const repo = new MeetingRepository(db), provision = new MeetProvisioner(db, tokens, new MeetApi());
  app.use('*', bodyLimit({ maxSize: 8192 }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    if (c.req.method !== 'GET' && (c.req.header('origin') !== new URL(config.publicUrl).origin || !c.req.header('content-type')?.startsWith('application/json'))) throw new MeetingError(403, '同じサイトから操作してください');
    await next();
  });
  app.use('*', requireAuth);
  app.use('*', async (c, next) => {
    if (getIdentity(c).projectKey !== 'aedilis') throw new MeetingError(403, 'Aeへログインしてください');
    await next();
  });
  app.onError((error, c) => c.json({ error: error instanceof MeetingError ? error.message : 'Meet連携に失敗しました。再読込してください' }, error instanceof MeetingError ? error.status : 503));
  app.get('/status', async c => {
    const identity = getIdentity(c), token = await tokens.get(identity.userId);
    const organizer = db.prepare('SELECT user_id FROM meet_organizer WHERE singleton=1').get() as { user_id: string } | undefined;
    return c.json({ configured: !!config.clientId && !!config.clientSecret, isAdmin: identity.isAdmin, organizerConnected: !!organizer, isOrganizer: organizer?.user_id === identity.userId, googleConnected: !!token?.metadata?.emailVerified, email: token?.metadata?.email || null });
  });
  app.post('/oauth/start', async c => {
    const input = object(await c.req.json());
    if (input.mode !== 'creator' && input.mode !== 'organizer') throw new MeetingError(400, '認可の種類を選んでください');
    return c.json({ url: oauth.begin(c, getIdentity(c), input.mode, typeof input.returnPath === 'string' ? input.returnPath : '') });
  });
  app.get('/oauth/callback', async c => {
    return c.redirect(await oauth.complete(c, getIdentity(c)));
  });
  app.get('/:id', c => {
    const row = repo.get(c.req.param('id'));
    if (row.state === 'cancelled') return c.json({ status: 'cancelled' });
    return c.json(provision.get(row.id));
  });
  app.post('/:id', async c => {
    const row = repo.get(c.req.param('id')), identity = getIdentity(c);
    const actor = await actorFor(db, c);
    repo.requireOwner(row, actor);
    if (!row.online_allowed || row.state === 'cancelled') throw new MeetingError(409, 'オンライン参加を有効にした会議で作成できます');
    return c.json(await provision.ensure(row.id, identity.userId));
  });
  return app;
}
