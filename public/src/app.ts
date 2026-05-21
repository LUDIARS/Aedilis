// Aedilis 最小 SPA — 施設一覧 + 予約フォーム + 自分の予約。
// vanilla TS。 esbuild で public/app.js にバンドルされる。

import { api, type ApiError, type Facility, type Reservation } from './api.ts';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};

function formatRange(startMs: number, endMs: number): string {
  const s = new Date(startMs);
  const e = new Date(endMs);
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${s.getFullYear()}/${p(s.getMonth() + 1)}/${p(s.getDate())}`;
  const st = `${p(s.getHours())}:${p(s.getMinutes())}`;
  const et = `${p(e.getHours())}:${p(e.getMinutes())}`;
  return `${day} ${st}–${et}`;
}

let facilities: Facility[] = [];

function renderFacilityOptions(): void {
  const sel = $('f-facility') as HTMLSelectElement;
  sel.innerHTML = '';
  for (const f of facilities) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.location ? `${f.name} (${f.location})` : f.name;
    sel.appendChild(opt);
  }
}

function renderReservations(list: Reservation[], myUserId: string): void {
  const root = $('reservations');
  root.innerHTML = '';
  if (list.length === 0) {
    root.innerHTML = '<p class="empty">予約はありません</p>';
    return;
  }
  for (const r of list) {
    const card = document.createElement('div');
    card.className = 'card';
    const mine = r.owner_user_id === myUserId;
    card.innerHTML = `
      <div class="card-main">
        <div class="card-title">${escapeHtml(r.facility_name ?? r.facility_id)}</div>
        <div class="card-time">${formatRange(r.start_at, r.end_at)}</div>
        ${r.purpose ? `<div class="card-purpose">${escapeHtml(r.purpose)}</div>` : ''}
        <div class="card-owner">${escapeHtml(r.owner_display_name ?? '—')}</div>
      </div>`;
    if (mine) {
      const btn = document.createElement('button');
      btn.className = 'cancel-btn';
      btn.textContent = 'キャンセル';
      btn.onclick = () => void doCancel(r.id);
      card.appendChild(btn);
    }
    root.appendChild(card);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    const m: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    };
    return m[ch] ?? ch;
  });
}

function setStatus(msg: string, kind: 'ok' | 'err' | ''): void {
  const el = $('status');
  el.textContent = msg;
  el.className = kind;
}

let currentUserId = '';

async function refresh(): Promise<void> {
  const { items } = await api.reservations('');
  renderReservations(items, currentUserId);
}

async function doCancel(id: string): Promise<void> {
  if (!confirm('この予約をキャンセルしますか?')) return;
  try {
    await api.cancelReservation(id);
    setStatus('キャンセルしました', 'ok');
    await refresh();
  } catch (e) {
    setStatus(`キャンセル失敗: ${(e as ApiError).body.error ?? 'error'}`, 'err');
  }
}

async function doCreate(ev: Event): Promise<void> {
  ev.preventDefault();
  const facilityId = ($('f-facility') as HTMLSelectElement).value;
  const startLocal = ($('f-start') as HTMLInputElement).value;
  const endLocal = ($('f-end') as HTMLInputElement).value;
  const purpose = ($('f-purpose') as HTMLInputElement).value;
  if (!facilityId || !startLocal || !endLocal) {
    setStatus('施設・開始・終了を入力してください', 'err');
    return;
  }
  try {
    await api.createReservation({
      facilityId,
      startAt: new Date(startLocal).toISOString(),
      endAt: new Date(endLocal).toISOString(),
      purpose,
    });
    setStatus('予約しました', 'ok');
    ($('f-purpose') as HTMLInputElement).value = '';
    await refresh();
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 409) {
      setStatus('その時間帯はすでに予約があります', 'err');
    } else {
      setStatus(`予約失敗: ${err.body.error ?? 'error'}`, 'err');
    }
  }
}

async function main(): Promise<void> {
  try {
    const me = await api.me();
    currentUserId = me.userId;
    $('user').textContent = me.displayName ?? me.userId;
  } catch {
    $('app').innerHTML =
      '<p class="empty">ログインが必要です。 Cernere でログインしてからアクセスしてください。</p>';
    return;
  }
  facilities = (await api.facilities()).items;
  renderFacilityOptions();
  $('reserve-form').addEventListener('submit', (e) => void doCreate(e));
  await refresh();
}

void main();
