import { randomBytes } from 'node:crypto';
import type { CernereComposite } from '../vendor/cernere-composite/composite.js';
import type { BoundServiceSession, ServiceOperation, ServiceOperationRisk } from '../vendor/cernere-composite/service-session.js';
import { MeetingError } from './types.ts';
import { contract } from '../lib/contract-observer.ts'; /* augur-inject:import:49c65da6 */
import augurContract_80cffb7f from '../contracts/meeting-login.contract.ts'; /* augur-inject:contract-predicate:80d82619 */
import augurContract_418fa5f1 from '../contracts/meeting-operation.contract.ts'; /* augur-inject:contract-predicate:af9dd162 */

interface LoginAttempt { expiresAt: number; claimed: boolean; cancelled: boolean; sessionId?: string }
export interface OwnSession { id: string; grant: BoundServiceSession; expiresAt: number }
type Authority = Pick<CernereComposite, 'exchange' | 'sessions'>;
const opaque = (): string => randomBytes(32).toString('base64url');

/** Process-owned sessions disappear on restart. No credential is stored in a browser. */
export class MeetingSessions {
  private readonly attempts = new Map<string, LoginAttempt>();
  private readonly sessions = new Map<string, OwnSession>();
  constructor(private readonly authority: Authority, private readonly now: () => number = Date.now) {}
  beginLogin(previous?: string): string {
    this.cancelLogin(previous);
    this.sweep();
    if (this.attempts.size >= 10_000) throw new MeetingError(429, '時間をおいてログインしてください');
    const nonce = opaque();
    this.attempts.set(nonce, { expiresAt: this.now() + 300_000, claimed: false, cancelled: false });
    return nonce;
  }
  cancelLogin(nonce?: string): void {
    const attempt = nonce ? this.attempts.get(nonce) : undefined;
    if (attempt) attempt.cancelled = true;
    if (attempt?.sessionId) this.sessions.delete(attempt.sessionId);
    if (nonce) this.attempts.delete(nonce);
  }
  async completeLogin(nonce: string, code: string, verifier: string): Promise<OwnSession> {
    const attempt = this.attempts.get(nonce);
    if (!attempt || attempt.claimed || attempt.cancelled || attempt.expiresAt <= this.now()
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !code || code.length > 2048) {
      throw new MeetingError(403, 'ログインをやり直してください');
    }
    // Claim before the first await, even when exchange/bind has an unknown outcome.
    attempt.claimed = true;
    const startedAt = this.now(), id = opaque();
    let grant: BoundServiceSession | undefined;
    try {
      const exchanged = await this.authority.exchange(code, verifier);
      if (!this.currentAttempt(nonce, attempt)) throw new MeetingError(401, 'ログインが中断されました');
      grant = await this.authority.sessions.bind(exchanged.projectToken, id);
      const expiry = Date.parse(grant.expiresAt);
      if (!this.currentAttempt(nonce, attempt) || grant.projectKey !== 'aedilis' || grant.user.id !== exchanged.user.id
        || !Number.isFinite(expiry) || expiry <= this.now() || expiry > this.now() + 900_000) {
        throw new MeetingError(401, 'ログインが失効しました');
      }
      this.sweep();
      if (this.sessions.size >= 10_000) throw new MeetingError(429, '時間をおいてログインしてください');
      const session = { id, grant, expiresAt: Math.min(expiry, startedAt + 900_000) };
      this.sessions.set(id, session);
      attempt.sessionId = id;
      return session;
    } catch (error) {
      if (grant) await this.authority.sessions.revoke(grant).catch(() => { /* Original grant expiry bounds remote cleanup failure; no local session is published. */ });
      throw error;
    } finally {
      // Retain the consumed nonce briefly: a logout carrying the old cookie can
      // still invalidate a successful bind whose Set-Cookie response is in flight.
      if (!attempt.sessionId) this.attempts.delete(nonce);
    }
  }
  private currentAttempt(nonce: string, attempt: LoginAttempt): boolean {
    return this.attempts.get(nonce) === attempt && !attempt.cancelled && attempt.expiresAt > this.now();
  }
  current(id: string): OwnSession | undefined {
    const session = this.sessions.get(id);
    if (session && session.expiresAt > this.now()) return session;
    this.sessions.delete(id);
    return undefined;
  }
  async check(id: string): Promise<OwnSession> {
    const session = this.current(id);
    if (!session) throw new MeetingError(401, 'ログインが失効しました');
    try {
      const checked = await this.authority.sessions.check(session.grant);
      if (this.current(id) !== session || checked.projectKey !== 'aedilis' || Date.parse(checked.expiresAt) > Date.parse(session.grant.expiresAt)) {
        throw new MeetingError(401, 'ログインが失効しました');
      }
      session.expiresAt = Math.min(session.expiresAt, Date.parse(checked.expiresAt));
      session.grant = checked;
      return session;
    } catch (error) { this.sessions.delete(id); throw error; }
  }
  async logout(id?: string, nonce?: string): Promise<void> {
    const published = nonce ? this.attempts.get(nonce)?.sessionId : undefined;
    const pendingSession = published ? this.sessions.get(published) : undefined;
    const session = id ? this.sessions.get(id) : undefined;
    this.cancelLogin(nonce);
    if (id) this.sessions.delete(id);
    if (session) await this.authority.sessions.revoke(session.grant);
    if (pendingSession && pendingSession !== session) await this.authority.sessions.revoke(pendingSession.grant);
  }
  async run<T>(id: string, operation: ServiceOperation, risk: ServiceOperationRisk,
    authorize: () => Promise<boolean>, execute: (authorizeCurrent: () => Promise<boolean>) => Promise<T>): Promise<T> {
    const session = this.current(id);
    if (!session) throw new MeetingError(401, 'ログインが失効しました');
    return this.authority.sessions.run(session.grant, operation, {
      risk,
      // Remote authorization/consumption must finish before the caller acquires
      // its local transaction. The execute callback owns the ACL+mutation unit.
      authorizeResource: async () => this.current(id) === session && await authorize() && this.current(id) === session,
      execute: async () => {
        if (this.current(id) !== session) throw new MeetingError(401, 'ログインが失効しました');
        return execute(async () => this.current(id) === session && await authorize() && this.current(id) === session);
      },
    });
  }
  private sweep(): void {
    for (const [nonce, attempt] of this.attempts) if (attempt.expiresAt <= this.now()) this.attempts.delete(nonce);
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(id);
  }
  close(): void {
    for (const attempt of this.attempts.values()) attempt.cancelled = true;
    this.attempts.clear(); this.sessions.clear();
  }
}
MeetingSessions.prototype.run = contract(MeetingSessions.prototype.run, { ...augurContract_418fa5f1, contractId: 'C-6', mode: 'observe', sample: 1, where: 'server/meetings/scoped-sessions.ts:98', rule: 'contract-wrap', id: '418fa5f1' }); /* augur-inject:contract-wrap:418fa5f1 */
MeetingSessions.prototype.completeLogin = contract(MeetingSessions.prototype.completeLogin, { ...augurContract_80cffb7f, contractId: 'C-5', mode: 'observe', sample: 1, where: 'server/meetings/scoped-sessions.ts:33', rule: 'contract-wrap', id: '80cffb7f' }); /* augur-inject:contract-wrap:80cffb7f */
