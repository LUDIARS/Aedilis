import { action, element, request, status, type Config } from './model.ts';

export async function refreshAccount(config: Config): Promise<void> {
  const session = await request<{ linked: boolean; notifications: boolean }>('/session', 'POST', {});
  element('identity').textContent = session.linked ? 'Cernereでログイン中' : 'この端末で利用（ログイン不要）';
  element('identity-help').textContent = session.linked ? '登録した回答は、別端末でも同じCernereアカウントで編集できます。ログインは15分で失効します。' : 'Cookieを消すと編集できなくなります。Cernereに登録・ログインして、この端末の回答を引き継げます。';
  element('login').hidden = session.linked;
  element<HTMLButtonElement>('login').disabled = !config.cernereUrl;
  if (!config.cernereUrl && !session.linked) element('identity-help').textContent += ' Cernere連携は管理者による公開URLの設定待ちです。';
  for (const id of ['link', 'logout', 'notifications-label', 'delivery', 'cernere-profile']) element(id).hidden = !session.linked;
  element<HTMLInputElement>('notifications').checked = session.notifications;
  element('notification-help').textContent = config.discordEnabled ? '通知を受け取るにはCernereでDiscordを連携してください。' : 'Discord通知は管理者による設定待ちです。';
  const profile = element<HTMLAnchorElement>('cernere-profile');
  profile.hidden = !session.linked || !config.cernereUrl;
  if (config.cernereUrl) profile.href = new URL('/', config.cernereUrl).href;
}
function receiveAuth(popup: Window, origin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let closeObserved = false;
    const cleanup = (): void => { clearInterval(timer); window.removeEventListener('message', listener); };
    const listener = (event: MessageEvent): void => {
      if (event.origin !== origin || event.source !== popup || !event.data || event.data.type !== 'cernere:auth' || typeof event.data.authCode !== 'string') return;
      cleanup(); resolve(event.data.authCode);
    };
    const timer = setInterval(() => {
      // Give the queued postMessage event one interval to arrive after popup.close().
      if ((popup.closed && closeObserved) || Date.now() - start > 300000) { cleanup(); popup.close(); reject(new Error('ログインが中断されました')); }
      closeObserved = popup.closed;
    }, 1000);
    window.addEventListener('message', listener);
  });
}
export function setupAccount(config: Config, reload: () => Promise<void>): void {
  element('login').onclick = () => {
    const popup = window.open('about:blank', `aedilis-login-${crypto.randomUUID()}`, 'width=540,height=740');
    if (!popup) { status('ログイン用ポップアップを許可してください', true); return; }
    void action(async () => {
      try {
        const { nonce } = await request<{ nonce: string }>('/session/login/start', 'POST', {});
        const url = new URL('/composite/login', config.cernereUrl); url.searchParams.set('origin', location.origin);
        const auth = receiveAuth(popup, url.origin); popup.location.href = url.href;
        const code = await auth;
        await request('/session/login/complete', 'POST', { code, nonce });
        await request('/session/link', 'POST', {});
        await refreshAccount(config); await reload(); status('この端末の会議・回答をCernereに引き継ぎました');
      } finally { popup.close(); }
    });
  };
  element('link').onclick = () => { void action(async () => { await request('/session/link', 'POST', {}); await refreshAccount(config); await reload(); status('この端末の回答を引き継ぎました'); }); };
  element('logout').onclick = () => { void action(async () => { await request('/session/logout', 'POST', {}); await refreshAccount(config); await reload(); status('ログアウトしました'); }); };
  element<HTMLInputElement>('notifications').onchange = () => { void action(async () => {
    const checkbox = element<HTMLInputElement>('notifications'), enabled = checkbox.checked;
    try { await request('/session/notifications', 'POST', { enabled }); status(enabled ? 'Discord通知を有効にしました' : 'Discord通知を停止しました'); }
    catch (err) { checkbox.checked = !enabled; throw err; }
  }); };
  const deliveries = async (): Promise<void> => {
    const { items } = await request<{ items: Array<{ event: string; status: string; attempts: number; error: string | null }> }>('/session/notifications');
    const list = element('delivery-list'); list.replaceChildren();
    const labels: Record<string, string> = { sent: '送信済み', pending: '送信待ち', failed: '送信失敗', skipped: '通知停止' };
    for (const item of items) { const li = document.createElement('li'); li.textContent = `${labels[item.status] || item.status}（試行${item.attempts}回）${item.error ? `: ${item.error}` : ''}`; list.append(li); }
    if (!items.length) list.textContent = '通知はまだありません';
  };
  element('delivery-refresh').onclick = () => { void action(deliveries); };
  element('delivery-retry').onclick = () => { void action(async () => { await request('/session/notifications/retry', 'POST', {}); await deliveries(); status('失敗した通知を再送待ちにしました'); }); };
}
