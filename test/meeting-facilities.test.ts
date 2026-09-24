import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { makeMeetingRouter } from '../server/meetings/routes.ts';
import { validateFacilities } from '../server/meetings/facilities.ts';
import { meetingInput } from '../server/meetings/validation.ts';
import type { FacilitySource } from '../server/facility/source.ts';
import type { CernereProjectClient } from '../server/lib/cernere-project-client.ts';

const facility = { id: 'room', name: 'Meeting room', location: 'Private location', equipment: ['Internal inventory'], capacity: 12, allowOverlap: false };
const source: FacilitySource = { sourceName: 'test', listFacilities: async () => [facility], getFacility: async id => id === facility.id ? facility : null };
const draft = () => meetingInput({ title: 'Meeting', description: '', organizerName: 'Host', slots: [{ id: 'one', startAt: '2026-10-01T01:00:00Z', endAt: '2026-10-01T02:00:00Z', venue: facility.name }], venues: [{ name: facility.name, facilityId: facility.id, busy: [] }] });

it('exposes only facility IDs and names without a cookie or authorization header', async () => {
  const db = new Database(':memory:');
  try {
    const app = makeMeetingRouter(db, { publicUrl: 'https://ae.example.com', cernereUrl: '', cernerePublicUrl: '', googleClientId: '', discordToken: null, notificationIntervalMs: 1000, notificationMaxAttempts: 1 }, {} as CernereProjectClient, source);
    const result = await app.request('/facilities');
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({ items: [{ id: 'room', name: 'Meeting room' }] });
  } finally { db.close(); }
});

it('preserves facility linkage and rejects unknown or mismatched facilities', async () => {
  const input = draft();
  const venue = input.venues[0];
  if (!venue) throw new Error('Fixture venue missing');
  expect((await validateFacilities(input, source)).venues[0]?.facilityId).toBe('room');
  await expect(validateFacilities({ ...input, venues: [{ ...venue, facilityId: 'missing' }] }, source)).rejects.toThrow('施設');
  await expect(validateFacilities({ ...input, venues: [{ ...venue, name: 'Spoofed room' }] }, source)).rejects.toThrow('施設');
  await expect(validateFacilities(input)).rejects.toThrow('施設');
});

it('continues accepting legacy and manually entered venues', async () => {
  const input = draft();
  input.venues = [{ name: facility.name, busy: [] }];
  expect(await validateFacilities(input)).toEqual(input);
});
