import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { meetingPages } from '../server/meetings/pages.ts';

it('serves REST meeting pages and redirects historical links without losing the meeting ID', async () => {
  const app = new Hono().route('/', meetingPages());
  for (const asset of ['/meetings.js', '/meetings.css', '/meetings-controls.css']) app.get(asset, c => c.text('asset'));
  const id = '7395f8d0-a6b6-4c44-808b-24e3073dc777';
  const page = await app.request(`/meeting/${id}`);
  expect(page.status).toBe(200);
  expect(page.headers.get('referrer-policy')).toBe('no-referrer');
  const html = await page.text();
  expect(html).toContain('response-default-online');
  expect(html).toContain('/meetings.js?v=20260924-calendar-2');
  for (const asset of ['/meetings.js', '/meetings.css', '/meetings-controls.css']) {
    // The page router supplies headers before the outer static asset handler.
    const response = await app.request(`${asset}?v=20260924-calendar-2`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  for (const path of [`/meetings?meeting=${id}`, `/meetings.html?meeting=${id}`, `/meetings/?meeting=${id}`, `/meeting/${id}/`]) {
    const redirect = await app.request(path);
    expect(redirect.status).toBe(308); expect(redirect.headers.get('location')).toBe(`/meeting/${id}`);
  }
  expect((await app.request('/meeting/not-an-id')).status).toBe(404);
  expect((await app.request('/meetings?meeting=https://example.com')).status).toBe(404);
});
