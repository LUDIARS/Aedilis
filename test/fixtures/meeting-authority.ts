import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { CompositeServiceSessions, type AuthorityCall } from '../../server/vendor/cernere-composite/service-session.js';
import { MeetingSessions } from '../../server/meetings/scoped-sessions.ts';

/** Real SDK guard over a controllable authority, never a permissive replacement guard. */
export function meetingAuthority(userId = 'cr-organizer') {
  const user = { id: userId, role: 'general', displayName: 'Organizer', email: null };
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const metadata = () => ({ user, projectKey: 'aedilis', expiresAt });
  const users = new Map([['project-token', user]]), bindings = new Map<string, string>(), revoked = new Set<string>();
  const riskFor = (action: unknown) => action === 'meetings.facilities.read' ? 'read'
    : String(action).endsWith('.read') ? 'sensitive_read' : 'important';
  const call = vi.fn<AuthorityCall>(async (action, input) => {
    const value = input as Record<string, unknown>;
    const token = String(value.projectToken), subject = users.get(token);
    if (!subject) throw new Error('unknown grant');
    if (action === 'revoke') { revoked.add(token); return { revoked: true }; }
    if (revoked.has(token)) throw new Error('revoked');
    if (action === 'bind') {
      if (bindings.has(token) && bindings.get(token) !== value.sessionBinding) throw new Error('already bound');
      bindings.set(token, value.sessionBinding as string);
      return { ...metadata(), user: subject };
    }
    if (value.sessionBinding !== bindings.get(token)) throw new Error('wrong session');
    if (action === 'check') return { ...metadata(), user: subject };
    if (action === 'authorize') return { permit: 'p'.repeat(43), expiresIn: 30, risk: riskFor(value.action) };
    if (action === 'consume') return { allowed: true, requestId: value.requestId, risk: riskFor(value.action) };
    throw new Error('unclassified authority call');
  });
  const exchange = vi.fn(async (code: string, _verifier: string) => {
    const id = code.startsWith('fixture-user:') ? code.slice('fixture-user:'.length) : userId;
    const subject = { ...user, id }, projectToken = id === userId ? 'project-token' : `fixture-grant:${id}`;
    users.set(projectToken, subject); return { projectToken, user: subject };
  });
  const sessions = new MeetingSessions({ exchange, sessions: new CompositeServiceSessions(call) });
  const login = async (id = userId) => sessions.completeLogin(sessions.beginLogin(), id === userId ? 'code' : `fixture-user:${id}`, 'v'.repeat(43));
  return { sessions, call, exchange, login, user, metadata,
    bindingFor: (id: string) => createHash('sha256').update(id).digest('base64url') };
}
