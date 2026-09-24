import { MeetingError } from '../meetings/types.ts';

export async function googleJson<T>(url: string, init: RequestInit, send: typeof fetch = fetch): Promise<T> {
  let response: Response;
  try { response = await send(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { throw new MeetingError(503, 'Googleへの接続結果を確認できませんでした'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MeetingError(503, `Googleの認可・設定を確認してください（HTTP ${response.status}）`);
  }
  try { return await response.json() as T; }
  catch { throw new MeetingError(503, 'Googleの応答を確認できませんでした'); }
}
