import { createHash } from 'node:crypto';
import type { CernereProjectClient } from '../lib/cernere-project-client.ts';
import { MeetingError } from './types.ts';

export async function discordIdentity(client: CernereProjectClient, userId: string): Promise<string> {
  let claims: unknown;
  try { claims = await client.request('managed_project', 'get_identity_claims', { userId, claims: ['discord_id'] }); }
  catch { throw new MeetingError(503, 'CernereのDiscord連携権限を確認できません'); }
  const id = (claims as { discord_id?: unknown } | null)?.discord_id;
  if (typeof id !== 'string' || !/^\d{10,25}$/.test(id)) throw new MeetingError(409, 'CernereでDiscordアカウントを連携してください');
  return id;
}
export class DiscordDeliveryError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs = 60000) { super(`discord_http_${status}`); }
}
async function post(token: string, path: string, body: unknown): Promise<{ id: string }> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let delay = 60000;
    if (res.status === 429) {
      const result = await res.json() as { retry_after?: number };
      delay = Math.max(1000, Math.min(3600000, Number(result.retry_after || 60) * 1000));
    }
    throw new DiscordDeliveryError(res.status, delay);
  }
  const result = await res.json() as { id?: unknown };
  if (typeof result.id !== 'string') throw new Error('discord_invalid_response');
  return { id: result.id };
}
export async function sendDiscord(token: string, recipient: string, eventId: string, content: string): Promise<string> {
  const dm = await post(token, '/users/@me/channels', { recipient_id: recipient });
  const result = await post(token, `/channels/${dm.id}/messages`, {
    content, allowed_mentions: { parse: [] },
    nonce: createHash('sha256').update(eventId).digest('hex').slice(0, 24), enforce_nonce: true,
  });
  return result.id;
}
