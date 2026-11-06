import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { CompositeServiceSessions, type AuthorityCall } from '../../server/vendor/cernere-composite/service-session.js';
import { MeetingSessions } from '../../server/meetings/scoped-sessions.ts';

/** Real SDK guard over a controllable authority, never a permissive replacement guard. */
export function meetingAuthority(userId = 'cr-organizer') {
  const user = { id: userId, role: 'general', displayName: 'Organizer', email: null };
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const metadata = () => ({ user, projectKey: 'aedilis', expiresAt });
  const riskFor = (action: unknown) => action === 'meetings.facilities.read' ? 'read'
    : String(action).endsWith('.read') ? 'sensitive_read' : 'important';
  let revoked = false, bound: string | undefined;
  const call = vi.fn<AuthorityCall>(async (action, input) => {
    const value = input as Record<string, unknown>;
    if (action === 'revoke') { revoked = true; return { revoked: true }; }
    if (revoked) throw new Error('revoked');
    if (action === 'bind') {
      if (bound && bound !== value.sessionBinding) throw new Error('already bound');
      bound = value.sessionBinding as string;
      return metadata();
    }
    if (value.sessionBinding !== bound) throw new Error('wrong session');
    if (action === 'check') return metadata();
    if (action === 'authorize') return { permit: 'p'.repeat(43), expiresIn: 30, risk: riskFor(value.action) };
    if (action === 'consume') return { allowed: true, requestId: value.requestId, risk: riskFor(value.action) };
    throw new Error('unclassified authority call');
  });
  const exchange = vi.fn(async (_code: string, _verifier: string) => ({ projectToken: 'project-token', user }));
  const sessions = new MeetingSessions({ exchange, sessions: new CompositeServiceSessions(call) });
  const login = async () => sessions.completeLogin(sessions.beginLogin(), 'code', 'v'.repeat(43));
  return { sessions, call, exchange, login, user, metadata,
    bindingFor: (id: string) => createHash('sha256').update(id).digest('base64url') };
}
