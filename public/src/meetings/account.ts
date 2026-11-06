import { action, element, request, status, type Config } from './model.ts';
import { createPkce, receiveAuth } from './pkce-login.ts';

let signedIn = false;
/** Whether this browser is signed in to Cernere; meeting creation requires it. */
export function isSignedIn(): boolean { return signedIn; }
export async function refreshAccount(config: Config, signal?: AbortSignal): Promise<void> {
  const session = await request<{ linked: boolean; notifications: boolean }>('/session', 'POST', {}, signal);
  signal?.throwIfAborted();
  signedIn = session.linked;
  element('identity').textContent = session.linked ? 'Cernereでログイン中' : 'この端末で利用（回答のみ・ログイン不要）';
  element('identity-help').textContent = session.linked ? '登録した回答は、別端末でも同じCernereアカウントで編集できます。ログインは15分で失効します。' : '会議の作成にはCernereへの登録・ログインが必要です。回答はログインなしでもできます（主催者が許可した会議のみ）。Cookieを消すと編集できなくなります。';
  element('login').hidden = session.linked;
  element<HTMLButtonElement>('login').disabled = !config.cernereUrl || !config.cernereClientId;
  if (!config.cernereUrl && !session.linked) element('identity-help').textContent += ' Cernere連携は管理者による公開URLの設定待ちです。';
  for (const id of ['link', 'logout', 'notifications-label', 'delivery', 'cernere-profile']) element(id).hidden = !session.linked;
  element<HTMLInputElement>('notifications').checked = session.notifications;
  element('notification-help').textContent = config.discordEnabled ? '通知を受け取るにはCernereでDiscordを連携してください。' : 'Discord通知は管理者による設定待ちです。';
  const profile = element<HTMLAnchorElement>('cernere-profile');
  profile.hidden = !session.linked || !config.cernereUrl;
  if (config.cernereUrl) profile.href = new URL('/', config.cernereUrl).href;
}
let disposeAccount: (() => void) | undefined;
export function setupAccount(config: Config, reload: () => Promise<void>): () => void {
  disposeAccount?.();
  let disposed = false;
  const lifetime = new AbortController();
  let pending: { controller: AbortController; popup: Window; silent: boolean } | undefined;
  const cancel = (): void => {
    if (!pending) return;
    pending.silent = true; pending.controller.abort(); pending.popup.close();
  };
  const active = (): void => lifetime.signal.throwIfAborted();
  const reloadActive = async (): Promise<void> => { active(); await reload(); active(); };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true; cancel(); lifetime.abort(); window.removeEventListener('pagehide', cancel);
    element('login').onclick = null; element('link').onclick = null; element('logout').onclick = null;
    element<HTMLInputElement>('notifications').onchange = null;
    element('delivery-refresh').onclick = null; element('delivery-retry').onclick = null;
    if (disposeAccount === dispose) disposeAccount = undefined;
  };
  disposeAccount = dispose;
  const ownedAction = (task: () => Promise<void>): void => {
    void action(async () => { try { await task(); } catch (error) { if (!disposed) throw error; } });
  };
  window.addEventListener('pagehide', cancel);
  element('login').onclick = () => {
    if (pending || !config.cernereClientId) return;
    const popup = window.open('about:blank', `aedilis-login-${crypto.randomUUID()}`, 'width=540,height=740');
    if (!popup) { status('ログイン用ポップアップを許可してください', true); return; }
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, lifetime.signal]);
    let waitingForSetup = true;
    const deadline = setTimeout(() => controller.abort(new Error('ログインがタイムアウトしました')), 300_000);
    const setupWatch = setInterval(() => { if (waitingForSetup && popup.closed) controller.abort(new Error('ログインが中断されました')); }, 500);
    const owner = { controller, popup, silent: false };
    pending = owner;
    element<HTMLButtonElement>('login').disabled = true;
    void action(async () => {
      try {
        const { verifier, challenge, state } = await createPkce();
        signal.throwIfAborted();
        const { nonce } = await request<{ nonce: string }>('/session/login/start', 'POST', {}, signal);
        const url = new URL('/composite/login', config.cernereUrl); url.searchParams.set('origin', location.origin);
        url.searchParams.set('client_id', config.cernereClientId);
        url.searchParams.set('code_challenge', challenge); url.searchParams.set('code_challenge_method', 'S256');
        url.searchParams.set('state', state);
        signal.throwIfAborted();
        const auth = receiveAuth(popup, url.origin, state, signal);
        waitingForSetup = false;
        clearInterval(setupWatch);
        // Attach rejection before navigation, including navigation exceptions.
        void auth.catch(() => { /* The awaited promise below reports the same failure. */ });
        popup.location.href = url.href;
        const code = await auth;
        signal.throwIfAborted();
        await request('/session/login/complete', 'POST', { code, nonce, verifier }, signal);
        signal.throwIfAborted();
        await request('/session/link', 'POST', {}, signal);
        signal.throwIfAborted();
        await refreshAccount(config, signal); signal.throwIfAborted();
        await reloadActive(); signal.throwIfAborted(); status('この端末の会議・回答をCernereに引き継ぎました');
      } catch (error) {
        // Disposal/pagehide/logout are silent; popup close and timeout remain visible.
        if (!disposed && !owner.silent) throw signal.aborted && signal.reason instanceof Error ? signal.reason : error;
      } finally {
        clearTimeout(deadline); clearInterval(setupWatch);
        controller.abort(); popup.close();
        if (pending === owner) {
          pending = undefined;
          if (!disposed) element<HTMLButtonElement>('login').disabled = !config.cernereUrl || !config.cernereClientId;
        }
      }
    });
  };
  element('link').onclick = () => { ownedAction(async () => { await request('/session/link', 'POST', {}, lifetime.signal); await refreshAccount(config, lifetime.signal); await reloadActive(); status('この端末の回答を引き継ぎました'); }); };
  element('logout').onclick = () => { cancel(); ownedAction(async () => { await request('/session/logout', 'POST', {}, lifetime.signal); await refreshAccount(config, lifetime.signal); await reloadActive(); status('ログアウトしました'); }); };
  element<HTMLInputElement>('notifications').onchange = () => { ownedAction(async () => {
    const checkbox = element<HTMLInputElement>('notifications'), enabled = checkbox.checked;
    try { await request('/session/notifications', 'POST', { enabled }, lifetime.signal); active(); status(enabled ? 'Discord通知を有効にしました' : 'Discord通知を停止しました'); }
    catch (err) { if (!disposed) checkbox.checked = !enabled; throw err; }
  }); };
  const deliveries = async (): Promise<void> => {
    const { items } = await request<{ items: Array<{ event: string; status: string; attempts: number; error: string | null }> }>('/session/notifications', 'GET', undefined, lifetime.signal);
    active();
    const list = element('delivery-list'); list.replaceChildren();
    const labels: Record<string, string> = { sent: '送信済み', pending: '送信待ち', failed: '送信失敗', skipped: '通知停止' };
    for (const item of items) { const li = document.createElement('li'); li.textContent = `${labels[item.status] || item.status}（試行${item.attempts}回）${item.error ? `: ${item.error}` : ''}`; list.append(li); }
    if (!items.length) list.textContent = '通知はまだありません';
  };
  element('delivery-refresh').onclick = () => { ownedAction(deliveries); };
  element('delivery-retry').onclick = () => { ownedAction(async () => { await request('/session/notifications/retry', 'POST', {}, lifetime.signal); await deliveries(); active(); status('失敗した通知を再送待ちにしました'); }); };
  return dispose;
}
