import { action, element, type Meeting } from './model.ts';

interface Status { configured: boolean; isAdmin: boolean; organizerConnected: boolean; isOrganizer: boolean; googleConnected: boolean; email: string | null }
interface Meet { status: string; url?: string }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/meet${path}`, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(response.status === 401 ? 'CrにログインするとGoogle Meetを利用できます。' : result.error || 'Meet連携を確認できません');
  return result;
}
let account: Status | null = null;
export async function setupManagedMeet(): Promise<void> {
  for (const mode of ['creator', 'organizer'] as const) element(`meet-connect-${mode}`).onclick = () => { void action(async () => {
    const result = await api<{ url: string }>('/oauth/start', { mode, returnPath: location.pathname });
    location.assign(result.url);
  }); };
  await refreshManagedAccount();
}
export async function refreshManagedAccount(): Promise<void> {
  const creator = element<HTMLButtonElement>('meet-connect-creator'), organizer = element<HTMLButtonElement>('meet-connect-organizer');
  creator.hidden = true; organizer.hidden = true; account = null;
  try {
    account = await api<Status>('/status');
    element('meet-account-status').textContent = !account.configured ? 'Google Meetは管理者による接続設定待ちです。' : account.googleConnected ? `Google確認済み：${account.email}` : '共同主催者にするGoogleアカウントを確認してください。';
    creator.hidden = !account.configured || account.isOrganizer;
    organizer.hidden = !account.configured || !account.isAdmin;
    organizer.textContent = account.isOrganizer ? '管理アカウントを再認可' : '管理アカウントでGoogleを認可';
  } catch (error) { element('meet-account-status').textContent = error instanceof Error ? error.message : 'Meet連携を確認できません'; }
}
function showResult(result: Meet): void {
  const link = element<HTMLAnchorElement>('meet-link'); link.hidden = true; link.removeAttribute('href');
  if (result.status === 'ready' && result.url?.startsWith('https://meet.google.com/')) { link.href = result.url; link.hidden = false; }
  element('meet-result').textContent = ({ ready: '共同主催者と文字起こしの設定が完了しました。指定したGoogleアカウントで参加してください。', none: 'Meetはまだ作成されていません。', configuring: 'Meetの設定を再開できます。', creating: 'Meet作成結果を確認中です。管理者に確認してください。', uncertain: 'Meet作成結果が不明です。重複作成を防ぐため管理者に確認してください。', cancelled: '中止済みの会議です。' } as Record<string, string>)[result.status] || 'Meetの状態を確認してください。';
}
export async function renderManagedMeet(meeting: Meeting): Promise<void> {
  const panel = element('managed-meet'); panel.hidden = !meeting.onlineAllowed;
  if (panel.hidden) return;
  const create = element<HTMLButtonElement>('meet-create'); create.hidden = true;
  showResult({ status: 'none' });
  if (!account) { element('meet-result').textContent = 'Google Meetの利用にはCrへのログインが必要です。'; return; }
  try {
    const result = await api<Meet>(`/${meeting.id}`); showResult(result);
    create.hidden = !meeting.canManage || !account.configured || !account.organizerConnected || !account.googleConnected || meeting.state === 'cancelled' || ['ready', 'uncertain', 'creating'].includes(result.status);
    if (result.status === 'none' && !account.organizerConnected) element('meet-result').textContent = '管理者によるGoogle認可を待っています。';
    create.textContent = result.status === 'configuring' ? 'Meetの設定を再開' : 'Google Meetを作成';
    create.onclick = () => { void action(async () => {
      create.disabled = true;
      try { showResult(await api<Meet>(`/${meeting.id}`, {})); create.hidden = true; }
      finally { create.disabled = false; }
    }); };
  } catch (error) { element('meet-result').textContent = error instanceof Error ? error.message : 'Meetを確認できません'; }
}
