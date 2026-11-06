import type { ServiceOperationRisk } from '../vendor/cernere-composite/service-session.js';
import { MeetingError } from './types.ts';

export interface MeetingOperation { action: string; risk: ServiceOperationRisk; meetingId?: string; owner: boolean; responseId?: string }
/** Exact destination-owned allowlist. Neither request JSON nor Cr can downgrade risk. */
export function meetingOperation(method: string, path: string): MeetingOperation {
  const simple: Record<string, [string, ServiceOperationRisk]> = {
    'GET /facilities': ['meetings.facilities.read', 'read'],
    // ensureActor may create the first linked identity, so this is not read-only.
    'POST /session': ['meetings.session.ensure', 'important'],
    'POST /session/link': ['meetings.session.link', 'important'],
    'POST /session/notifications': ['meetings.notifications.update', 'important'],
    'GET /session/notifications': ['meetings.notifications.read', 'sensitive_read'],
    'POST /session/notifications/retry': ['meetings.notifications.retry', 'important'],
    'GET /mine': ['meetings.mine.read', 'sensitive_read'],
    'GET /': ['meetings.list.read', 'sensitive_read'],
    'POST /': ['meetings.create', 'important'],
  };
  const item = simple[`${method} ${path}`];
  if (item) return { action: item[0], risk: item[1], owner: false };
  const match = /^\/([^/]+)(?:\/(finalize|responses)(?:\/([^/]+))?)?$/.exec(path);
  if (match) {
    const [, meetingId, kind, responseId] = match;
    const actions: Record<string, string> = { 'GET ': 'read', 'PATCH ': 'update', 'DELETE ': 'cancel',
      'POST finalize': 'finalize', 'POST responses': 'response.create', 'PATCH responses': 'response.update', 'DELETE responses': 'response.delete' };
    const name = actions[`${method} ${kind ?? ''}`];
    if (name && (kind === 'responses' ? (method === 'POST' ? !responseId : !!responseId) : !responseId)) {
      return { action: `meetings.${name}`, risk: method === 'GET' ? 'sensitive_read' : 'important', meetingId,
        owner: !kind && method !== 'GET' || kind === 'finalize', responseId };
    }
  }
  throw new MeetingError(403, '許可された操作ではありません');
}
