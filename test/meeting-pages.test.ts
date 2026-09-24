import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { meetingPages } from '../server/meetings/pages.ts';

it('serves REST meeting pages and redirects historical links without losing the meeting ID', async () => {
  const app = new Hono().route('/', meetingPages());
  const id = '7395f8d0-a6b6-4c44-808b-24e3073dc777';
  const page = await app.request(`/meeting/${id}`);
  expect(page.status).toBe(200);
  expect(page.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await page.text()).toContain('response-default-online');
  for (const path of [`/meetings?meeting=${id}`, `/meetings.html?meeting=${id}`, `/meetings/?meeting=${id}`, `/meeting/${id}/`]) {
    const redirect = await app.request(path);
    expect(redirect.status).toBe(308); expect(redirect.headers.get('location')).toBe(`/meeting/${id}`);
  }
  expect((await app.request('/meeting/not-an-id')).status).toBe(404);
  expect((await app.request('/meetings?meeting=https://example.com')).status).toBe(404);
});
