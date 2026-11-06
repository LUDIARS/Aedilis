import { MeetingError } from '../meetings/types.ts';
import { googleJson } from './google-http.ts';
import type { MeetOperation } from './operation.ts';

interface Space { name: string; meetingUri: string }
export class MeetApi {
  constructor(private readonly send: typeof fetch = fetch) {}
  async create(token: string, operation?: MeetOperation): Promise<Space> {
    const space = await this.call<Space>(token, '/spaces', 'POST', { config: { accessType: 'RESTRICTED' } }, operation);
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(space.name) || !/^https:\/\/meet\.google\.com\/[a-z-]+$/.test(space.meetingUri)) throw new MeetingError(503, 'Meet作成結果を確認できません');
    return space;
  }
  async configure(token: string, name: string, email: string | null, operation?: MeetOperation): Promise<void> {
    await this.call(token, `/${name}?updateMask=config.moderation,config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration`, 'PATCH', { config: { moderation: 'ON', artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: 'ON' } } } }, operation);
    if (!email) return; // The Google organizer already has host privileges.
    let pageToken = '', found = false;
    do {
      const members = await this.call<{ members?: Array<{ name: string; email: string; role: string }>; nextPageToken?: string }>(token, `/${name}/members?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, 'GET', undefined, operation);
      const existing = members.members?.find(member => member.email.toLowerCase() === email.toLowerCase());
      if (existing) {
        if (existing.role !== 'COHOST') await this.call(token, `/${existing.name}?updateMask=role`, 'PATCH', { role: 'COHOST' }, operation);
        found = true; break;
      }
      pageToken = members.nextPageToken || '';
    } while (pageToken);
    if (!found) await this.call(token, `/${name}/members`, 'POST', { email, role: 'COHOST' }, operation);
  }
  private async call<T>(token: string, path: string, method: string, body?: unknown, operation?: MeetOperation): Promise<T> {
    await operation?.assertCurrent();
    return googleJson<T>(`https://meet.googleapis.com/v2${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(operation ? { signal: operation.signal } : {}) }, this.send);
  }
}
