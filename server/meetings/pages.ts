import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

/** Canonical meeting pages and compatibility redirects, separate from JSON API routes. */
export function meetingPages(): Hono {
  const app = new Hono();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const html = serveStatic({ path: './public/meetings.html' });
  // HTML and unversioned bundles must not be cached independently across deployments.
  // The HTML query revision also bypasses copies cached before this policy existed.
  for (const path of ['/meetings', '/meetings/', '/meetings.html', '/meeting/*', '/meetings.js', '/meetings.css', '/meetings-controls.css']) app.use(path, async (c, next) => {
    c.header('Referrer-Policy', 'no-referrer'); c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff'); c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/meeting/:id', async (c, next) => {
    if (!uuid.test(c.req.param('id'))) return c.text('会議URLが不正です', 404);
    return html(c, next);
  });
  app.get('/meeting/:id/', c => uuid.test(c.req.param('id'))
    ? c.redirect(`/meeting/${c.req.param('id')}`, 308) : c.text('会議URLが不正です', 404));
  app.get('/meetings', async (c, next) => {
    const id = c.req.query('meeting');
    if (id) return uuid.test(id) ? c.redirect(`/meeting/${id}`, 308) : c.text('会議URLが不正です', 404);
    return html(c, next);
  });
  for (const path of ['/meetings.html', '/meetings/']) {
    app.get(path, c => {
      const id = c.req.query('meeting');
      if (id && !uuid.test(id)) return c.text('会議URLが不正です', 404);
      return c.redirect(id ? `/meeting/${id}` : '/meetings', 308);
    });
  }
  return app;
}
