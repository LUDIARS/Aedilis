import { action, element, escape, label, status, type Config, type Range } from './model.ts';
import { importRanges, refreshVenues } from './editor.ts';

interface GoogleToken { access_token?: string; error?: string }
interface GoogleOAuth {
  initTokenClient(options: { client_id: string; scope: string; callback: (result: GoogleToken) => void; error_callback: () => void }): { requestAccessToken(): void };
}
declare global { interface Window { google?: { accounts: { oauth2: GoogleOAuth } } } }
interface Calendar { id: string; summary?: string }
interface CalendarEvent { id: string; summary?: string; status?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }
let token: string | null = null;
let events: Array<Range & { title: string }> = [];
let scriptLoading: Promise<void> | null = null;
function loadGoogle(): Promise<void> {
  if (window.google) return Promise.resolve();
  if (!scriptLoading) scriptLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
    script.onload = () => resolve(); script.onerror = () => { scriptLoading = null; script.remove(); reject(new Error('Googleとの接続に失敗しました')); };
    document.head.append(script);
  });
  return scriptLoading;
}
async function googleList<T>(path: string, params: URLSearchParams): Promise<T[]> {
  if (!token) throw new Error('Googleカレンダーへの接続をやり直してください');
  const all: T[] = [];
  let page = '';
  do {
    if (page) params.set('pageToken', page);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/${path}?${params}`, { headers: { Authorization: `Bearer ${token}` }, referrerPolicy: 'no-referrer' });
    if (!res.ok) { if (res.status === 401) token = null; throw new Error('Googleの読み取り権限・接続を確認してください'); }
    const data = await res.json() as { items?: T[]; nextPageToken?: string };
    all.push(...data.items || []); page = data.nextPageToken || '';
    if (all.length > 2000) throw new Error('予定が多すぎます。期間を短くしてください');
  } while (page);
  return all;
}
export function setupGoogle(config: Config): void {
  const button = element<HTMLButtonElement>('google-connect');
  button.disabled = !config.googleClientId;
  element('google-help').textContent = config.googleClientId ? 'Googleの予定は選択するまで公開されません。' : 'Googleカレンダー連携は管理者による設定待ちです。候補は手入力できます。';
  button.onclick = () => { void action(async () => {
    // Load on explicit use. If loading is asynchronous, a second click preserves popup user activation.
    if (!window.google) { await loadGoogle(); status('準備できました。「Googleカレンダーを選ぶ」をもう一度押してください'); return; }
    const client = window.google.accounts.oauth2.initTokenClient({ client_id: config.googleClientId,
      scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly',
      error_callback: () => status('Googleへの接続が中断されました', true),
      callback: result => { void action(async () => {
        if (!result.access_token || result.error) throw new Error('Googleカレンダーの読み取り許可が必要です');
        token = result.access_token;
        const calendars = await googleList<Calendar>('users/me/calendarList', new URLSearchParams({ maxResults: '250' }));
        element<HTMLSelectElement>('google-calendar').innerHTML = calendars.map(c => `<option value="${escape(c.id)}">${escape(c.summary || c.id)}</option>`).join('');
        element('google-controls').hidden = false;
        const today = new Date(), end = new Date(); end.setDate(end.getDate() + 30);
        const date = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        element<HTMLInputElement>('google-from').value = date(today); element<HTMLInputElement>('google-to').value = date(end);
        status('カレンダーと期間を選んでください');
      }); },
    });
    client.requestAccessToken();
  }); };
  element('google-load').onclick = () => { void action(async () => {
    const from = new Date(`${element<HTMLInputElement>('google-from').value}T00:00:00`), until = new Date(`${element<HTMLInputElement>('google-to').value}T00:00:00`);
    until.setDate(until.getDate() + 1);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime()) || until <= from || until.getTime() - from.getTime() > 92 * 86400000) throw new Error('期間は開始日から92日以内にしてください');
    const calendar = element<HTMLSelectElement>('google-calendar').value;
    const raw = await googleList<CalendarEvent>(`calendars/${encodeURIComponent(calendar)}/events`, new URLSearchParams({ timeMin: from.toISOString(), timeMax: until.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' }));
    events = raw.filter(e => e.status !== 'cancelled' && e.start && e.end).map(e => ({
      startAt: new Date(e.start?.dateTime || `${e.start?.date}T00:00:00`).toISOString(),
      endAt: new Date(e.end?.dateTime || `${e.end?.date}T00:00:00`).toISOString(), title: e.summary || '予定',
    }));
    element('google-events').innerHTML = events.map((e, i) => `<label><input type="checkbox" value="${i}">${escape(e.title)} — ${escape(label(e))}</label>`).join('') || '<p>この期間に予定はありません</p>';
    refreshVenues();
  }); };
  element('google-import').onclick = () => { void action(async () => {
    const selected = [...element('google-events').querySelectorAll<HTMLInputElement>('input:checked')].map(i => events[Number(i.value)]).filter((e): e is Range & { title: string } => !!e);
    if (!selected.length) throw new Error('取り込む予定を選んでください');
    importRanges(selected, element<HTMLSelectElement>('google-target').value);
    for (const i of element('google-events').querySelectorAll<HTMLInputElement>('input')) i.checked = false;
    status(`${selected.length}件の日時を取り込みました。会場と時刻を確認してから保存してください`);
  }); };
  window.addEventListener('pagehide', () => { token = null; events = []; });
}
