const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function createPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge, state: base64url(crypto.getRandomValues(new Uint8Array(32))) };
}
export function matchesAuthMessage(event: MessageEvent, popup: Window, origin: string, state: string): boolean {
  return event.source === popup && event.origin === origin && event.data?.type === 'cernere:auth'
    && event.data?.state === state && typeof event.data?.authCode === 'string' && event.data.authCode.length > 0;
}
/** The caller owns popup creation/navigation; this owns only message/timer listeners. */
export function receiveAuth(popup: Window, origin: string, state: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let closeObserved = false;
    const cleanup = (): void => {
      clearInterval(timer); window.removeEventListener('message', listener); signal.removeEventListener('abort', abort);
    };
    const abort = (): void => { cleanup(); reject(new Error('ログインが中断されました')); };
    const listener = (event: MessageEvent): void => {
      if (!matchesAuthMessage(event, popup, origin, state)) return;
      cleanup(); resolve(event.data.authCode);
    };
    const timer = setInterval(() => {
      if ((popup.closed && closeObserved) || Date.now() - started > 300_000) abort();
      closeObserved = popup.closed;
    }, 500);
    window.addEventListener('message', listener);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
