import type Database from 'better-sqlite3';
import type { CernereProjectClient } from '../lib/cernere-project-client.ts';
import type { MeetingConfig } from './config.ts';
import { discordIdentity, DiscordDeliveryError, sendDiscord } from './discord.ts';

interface Job { id: string; meeting_id: string; recipient_id: string; event: string; attempts: number }
const labels: Record<string, string> = {
  response_added: '参加者の回答が届きました', response_changed: '参加者の回答が変更されました',
  response_deleted: '参加者の回答が削除されました', meeting_changed: '会議の候補が変更されました。回答を確認してください',
  meeting_finalized: '会議の開催日時が確定しました', meeting_cancelled: '会議が中止されました',
};
/** Single-process worker; rows are leased before awaits, and leases survive restarts. */
export function startMeetingOutbox(db: Database.Database, client: CernereProjectClient, config: MeetingConfig): () => void {
  if (!config.discordToken) return () => undefined;
  let running = false, stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const jobs = db.prepare("SELECT * FROM meeting_outbox WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 5").all(Date.now()) as Job[];
      for (const job of jobs) {
        if (stopped) break;
        const lease = db.prepare("UPDATE meeting_outbox SET due_at=? WHERE id=? AND status='pending' AND due_at<=?").run(Date.now() + 120000, job.id, Date.now());
        if (!lease.changes) continue;
        try {
          const owner = db.prepare('SELECT user_id,notify FROM meeting_identity WHERE id=?').get(job.recipient_id) as { user_id: string | null; notify: number } | undefined;
          if (!owner?.user_id || !owner.notify) {
            db.prepare("UPDATE meeting_outbox SET status='skipped' WHERE id=?").run(job.id);
            continue;
          }
          const recipient = await discordIdentity(client, owner.user_id);
          const url = new URL(`/meeting/${encodeURIComponent(job.meeting_id)}`, config.publicUrl);
          url.searchParams.set('meeting', job.meeting_id);
          // No free text in notification content: private agendas and mentions stay on the meeting page.
          const messageId = await sendDiscord(config.discordToken as string, recipient, job.id, `Aedilis: ${labels[job.event] ?? '会議が更新されました'}\n${url.href}`);
          db.prepare("UPDATE meeting_outbox SET status='sent',message_id=?,last_error=NULL WHERE id=?").run(messageId, job.id);
        } catch (err) {
          const attempts = job.attempts + 1;
          const permanent = err instanceof DiscordDeliveryError && [400, 401, 403, 404].includes(err.status);
          const retryAfter = err instanceof DiscordDeliveryError ? err.retryAfterMs : 0;
          const delay = Math.max(retryAfter, Math.min(3600000, 15000 * 2 ** attempts));
          // Persist only a categorical error, not remote payloads/tokens or private messages.
          const code = err instanceof DiscordDeliveryError ? err.message : 'identity_or_delivery_unavailable';
          db.prepare('UPDATE meeting_outbox SET attempts=?,status=?,due_at=?,last_error=? WHERE id=?')
            .run(attempts, permanent || attempts >= config.notificationMaxAttempts ? 'failed' : 'pending', Date.now() + delay, code, job.id);
          // bootstrap installs Vestigium console capture for this process.
          console.warn(`[meetings] notification ${job.id}: ${code}`);
        }
      }
    } catch (err) {
      console.error('[meetings] outbox failure', err instanceof Error ? err.name : 'unknown');
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, config.notificationIntervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
