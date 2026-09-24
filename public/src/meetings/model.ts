export interface Range { startAt: string; endAt: string }
export interface Slot extends Range { id: string; venue: string }
export interface Venue { name: string; busy: Range[] }
export interface MeetingDraft { title: string; description: string; organizerName: string; slots: Slot[]; venues: Venue[] }
export interface Answer {
  id: string; name: string; comment: string; topic: string;
  answers: Record<string, 'yes' | 'maybe' | 'no'>; revision: number; canEdit: boolean;
}
export interface Meeting extends MeetingDraft {
  id: string; state: 'open' | 'finalized' | 'cancelled'; selectedSlot: string | null;
  revision: number; canManage: boolean; responses: Answer[];
}
export interface Config { googleClientId: string; cernereUrl: string; discordEnabled: boolean }
export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/meetings${path}`, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `通信に失敗しました (${res.status})`);
  return data;
}
export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
export function escape(value: string): string {
  return value.replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s] || s));
}
export function localInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function label(slot: Range): string {
  return `${new Date(slot.startAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })} 〜 ${new Date(slot.endAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}
export function status(message: string, error = false): void {
  const node = element('status'); node.textContent = message; node.classList.toggle('error', error);
}
export async function action(fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (err) { status(err instanceof Error ? err.message : '処理に失敗しました', true); }
}
