// Cernere PASETO V4 検証 + Hono middleware。
//
// Cernere は GET /.well-known/cernere-public-key で公開鍵を配る。
// 起動時 + 6h 毎に fetch、 in-memory cache から V4.verify で検証する。
// 認証必須エンドポイントには `requireAuth`、 admin 専用には `requireAdmin`。

import type { Context, MiddlewareHandler } from 'hono';
import { V4 } from 'paseto';

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface KeyEntry {
  key: Buffer;
  fetchedAt: number;
}

const keyCache = new Map<string, KeyEntry>();
let refreshTimer: NodeJS.Timeout | null = null;

export interface AuthIdentity {
  userId: string;
  role: string;
  displayName: string | null;
  projectKey: string | null;
  isAdmin: boolean;
}

interface AuthOptions {
  cernereBaseUrl: string;
  audience: string;
  adminIds: ReadonlySet<string>;
}

let optsRef: AuthOptions | null = null;

export function startAuth(opts: AuthOptions): void {
  // baseUrl の trailing slash を削る (後段の `+ /.well-known/...` で double slash 防止)
  optsRef = { ...opts, cernereBaseUrl: opts.cernereBaseUrl.replace(/\/+$/, '') };
  void refreshPublicKeys();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => void refreshPublicKeys(), REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

async function refreshPublicKeys(): Promise<void> {
  if (!optsRef) return;
  try {
    const res = await fetch(`${optsRef.cernereBaseUrl}/.well-known/cernere-public-key`);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: Array<{ kid: string; public_key: string }> };
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    let added = 0;
    for (const k of keys) {
      if (!k?.kid || !k?.public_key) continue;
      const buf = Buffer.from(k.public_key, 'base64');
      if (buf.length !== 32) {
        console.warn(`[auth] skipped kid=${k.kid} (length=${buf.length})`);
        continue;
      }
      keyCache.set(k.kid, { key: buf, fetchedAt: Date.now() });
      added++;
    }
    console.log(`[auth] public keys refreshed: +${added} total=${keyCache.size}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[auth] refresh failed: ${msg} (cache=${keyCache.size})`);
  }
}

async function verifyToken(token: string): Promise<AuthIdentity | null> {
  if (!optsRef) return null;
  if (!token.startsWith('v4.public.')) return null;
  for (const [kid, entry] of keyCache.entries()) {
    try {
      const result = (await V4.verify(token, entry.key, {
        complete: true,
        audience: optsRef.audience || undefined,
      })) as { payload?: Record<string, unknown> } | Record<string, unknown>;
      const payload = (
        'payload' in result && result.payload ? result.payload : result
      ) as Record<string, unknown>;
      if (payload.kind !== 'user_for_project') return null;
      const userId = typeof payload.sub === 'string' ? payload.sub : null;
      if (!userId) return null;
      void kid;
      return {
        userId,
        role: typeof payload.role === 'string' ? payload.role : 'general',
        displayName:
          typeof payload.displayName === 'string' ? payload.displayName : null,
        projectKey:
          typeof payload.projectKey === 'string' ? payload.projectKey : null,
        isAdmin: optsRef.adminIds.has(userId),
      };
    } catch {
      // try next kid
    }
  }
  return null;
}

function extractToken(c: Context): string | null {
  const h = c.req.header('authorization');
  if (h && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const cookie = c.req.header('cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)cernere_token=([^;]+)/);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  const identity = await verifyToken(token);
  if (!identity) return c.json({ error: 'invalid_token' }, 401);
  c.set('auth', identity);
  await next();
};

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const id = c.get('auth') as AuthIdentity | undefined;
  if (!id) return c.json({ error: 'unauthorized' }, 401);
  if (!id.isAdmin) return c.json({ error: 'admin_required' }, 403);
  await next();
};

export function getIdentity(c: Context): AuthIdentity {
  const id = c.get('auth') as AuthIdentity | undefined;
  if (!id) throw new Error('auth identity missing — requireAuth not mounted');
  return id;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthIdentity;
  }
}
