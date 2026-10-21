import { afterEach, describe, expect, it, vi } from 'vitest';
import { meetConfig } from '../server/meet/config.ts';
import { meetingConfig } from '../server/meetings/config.ts';

afterEach(() => vi.unstubAllEnvs());

describe('one shared operator-managed OAuth client', () => {
  it('uses the same configured client for Calendar and Meet without exposing the secret to Calendar', () => {
    vi.stubEnv('AEDILIS_GOOGLE_CLIENT_ID', ' shared-client ');
    vi.stubEnv('AEDILIS_GOOGLE_CLIENT_SECRET', ' server-only-secret ');
    vi.stubEnv('AEDILIS_DISCORD_HANDOFF_ENABLED', 'false');
    vi.stubEnv('AEDILIS_DISCORD_ENABLED', 'false');
    const calendar = meetingConfig('https://ae.example.com', 'https://cr.example.com');
    const meet = meetConfig('https://ae.example.com');
    expect(calendar.googleClientId).toBe('shared-client');
    expect(meet.clientId).toBe(calendar.googleClientId);
    expect(meet.clientSecret).toBe('server-only-secret');
    expect(JSON.stringify(calendar)).not.toContain('server-only-secret');
  });
  it('does not borrow another service OAuth client when Ae is unconfigured', () => {
    vi.stubEnv('AEDILIS_GOOGLE_CLIENT_ID', '');
    vi.stubEnv('AEDILIS_GOOGLE_CLIENT_SECRET', '');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'other-service-client');
    expect(meetConfig('https://ae.example.com').clientId).toBe('');
  });
});
