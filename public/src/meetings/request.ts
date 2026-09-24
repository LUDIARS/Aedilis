export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/meetings${path === '/' ? '' : path}`, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `通信に失敗しました (${res.status})`);
  return data;
}
