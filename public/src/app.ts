// Aedilis SPA — 施設一覧 + 予約 CRUD + フィルタ + admin 施設管理。
// vanilla TS。 esbuild で public/app.js にバンドルされる。

import { api, type ApiError, type Facility, type Reservation } from './api.ts';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    const m: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    };
    return m[ch] ?? ch;
  });
}

function formatRange(startMs: number, endMs: number): string {
  const s = new Date(startMs);
  const e = new Date(endMs);
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${s.getFullYear()}/${p(s.getMonth() + 1)}/${p(s.getDate())}`;
  return `${day} ${p(s.getHours())}:${p(s.getMinutes())}–${p(e.getHours())}:${p(e.getMinutes())}`;
}

/** epoch ms → datetime-local input value (YYYY-MM-DDTHH:mm)。 */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setStatus(msg: string, kind: 'ok' | 'err' | ''): void {
  const el = $('status');
  el.textContent = msg;
  el.className = kind;
}

function describeError(e: unknown): string {
  const err = e as ApiError;
  if (err?.status === 409) return 'その時間帯はすでに予約があります';
  if (err?.status === 403) return '権限がありません';
  if (err?.status === 404) return '対象が見つかりません';
  return err?.body?.error ?? 'error';
}

let currentUserId = '';
let isAdmin = false;
let facilities: Facility[] = [];

// ── 施設セレクタ / 詳細 ─────────────────────────────────────────────────────

function renderFacilityOptions(): void {
  const create = $('f-facility') as HTMLSelectElement;
  const filter = $('filter-facility') as HTMLSelectElement;
  create.innerHTML = '';
  filter.innerHTML = '<option value="">全施設</option>';
  for (const f of facilities) {
    const label = f.location ? `${f.name} (${f.location})` : f.name;
    const o1 = document.createElement('option');
    o1.value = f.id;
    o1.textContent = label;
    create.appendChild(o1);
    const o2 = o1.cloneNode(true) as HTMLOptionElement;
    filter.appendChild(o2);
  }
  renderFacilityInfo();
}

function renderFacilityInfo(): void {
  const sel = ($('f-facility') as HTMLSelectElement).value;
  const f = facilities.find((x) => x.id === sel);
  const box = $('facility-info');
  if (!f) {
    box.innerHTML = '';
    return;
  }
  const tags: string[] = [];
  if (f.capacity !== undefined) tags.push(`定員 ${f.capacity}`);
  if (f.allowOverlap) tags.push('重複可');
  for (const e of f.equipment ?? []) tags.push(escapeHtml(e));
  box.innerHTML =
    (f.location ? `${escapeHtml(f.location)} ・ ` : '') +
    tags.map((t) => `<span class="tag">${t}</span>`).join('');
}

// ── 予約一覧 ────────────────────────────────────────────────────────────────

function reservationCard(r: Reservation): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  const mine = r.owner_user_id === currentUserId;
  card.innerHTML = `
    <div class="card-main">
      <div class="card-title">${escapeHtml(r.facility_name ?? r.facility_id)}</div>
      <div class="card-time">${formatRange(r.start_at, r.end_at)}</div>
      ${r.purpose ? `<div class="card-purpose">${escapeHtml(r.purpose)}</div>` : ''}
      <div class="card-owner">${escapeHtml(r.owner_display_name ?? '—')}</div>
    </div>`;
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  if (mine) {
    const edit = document.createElement('button');
    edit.className = 'edit-btn';
    edit.textContent = '編集';
    edit.onclick = () => swapToEditForm(card, r);
    actions.appendChild(edit);
  }
  if (mine || isAdmin) {
    const cancel = document.createElement('button');
    cancel.className = 'cancel-btn';
    cancel.textContent = 'キャンセル';
    cancel.onclick = () => void doCancel(r.id);
    actions.appendChild(cancel);
  }
  if (actions.childElementCount > 0) card.appendChild(actions);
  return card;
}

function swapToEditForm(card: HTMLElement, r: Reservation): void {
  const form = document.createElement('div');
  form.className = 'edit-form';
  form.innerHTML = `
    <div class="card-title">${escapeHtml(r.facility_name ?? r.facility_id)} を編集</div>
    <div class="row">
      <input class="e-start" type="datetime-local" value="${toLocalInput(r.start_at)}" />
      <input class="e-end" type="datetime-local" value="${toLocalInput(r.end_at)}" />
    </div>
    <input class="e-purpose" type="text" maxlength="200" value="${escapeHtml(r.purpose)}" placeholder="目的 (任意)" />
    <div class="card-actions">
      <button class="edit-btn e-save">保存</button>
      <button class="cancel-btn e-abort">取消</button>
    </div>`;
  const start = form.querySelector('.e-start') as HTMLInputElement;
  const end = form.querySelector('.e-end') as HTMLInputElement;
  const purpose = form.querySelector('.e-purpose') as HTMLInputElement;
  (form.querySelector('.e-save') as HTMLButtonElement).onclick = () =>
    void doUpdate(r.id, start.value, end.value, purpose.value);
  (form.querySelector('.e-abort') as HTMLButtonElement).onclick = () =>
    void refresh();
  card.replaceWith(form);
}

function renderReservations(list: Reservation[]): void {
  const root = $('reservations');
  root.innerHTML = '';
  if (list.length === 0) {
    root.innerHTML = '<p class="empty">予約はありません</p>';
    return;
  }
  for (const r of list) root.appendChild(reservationCard(r));
}

// ── admin 施設管理 ──────────────────────────────────────────────────────────

function renderAdminPanel(): void {
  if (!isAdmin) return;
  $('admin-panel').hidden = false;
  const root = $('admin-facilities');
  root.innerHTML = '';
  for (const f of facilities) {
    const row = document.createElement('div');
    row.className = 'admin-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.location ? `${f.name} (${f.location})` : f.name;
    const toggle = document.createElement('label');
    toggle.className = 'toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = f.allowOverlap;
    cb.onchange = () => void doToggleOverlap(f.id, cb.checked);
    toggle.append(cb, document.createTextNode('重複可'));
    row.append(name, toggle);
    root.appendChild(row);
  }
}

// ── アクション ──────────────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  const mineOnly = ($('filter-mine') as HTMLInputElement).checked;
  const facilityId = ($('filter-facility') as HTMLSelectElement).value;
  try {
    let items: Reservation[];
    if (mineOnly) {
      items = (await api.myReservations()).items;
      if (facilityId) items = items.filter((r) => r.facility_id === facilityId);
    } else {
      const query = facilityId ? `?facility=${encodeURIComponent(facilityId)}` : '';
      items = (await api.reservations(query)).items;
    }
    renderReservations(items);
  } catch (e) {
    setStatus(`一覧取得失敗: ${describeError(e)}`, 'err');
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
    setStatus(`予約失敗: ${describeError(e)}`, 'err');
  }
}

async function doUpdate(
  id: string,
  startLocal: string,
  endLocal: string,
  purpose: string,
): Promise<void> {
  if (!startLocal || !endLocal) {
    setStatus('開始・終了を入力してください', 'err');
    return;
  }
  try {
    await api.updateReservation(id, {
      startAt: new Date(startLocal).toISOString(),
      endAt: new Date(endLocal).toISOString(),
      purpose,
    });
    setStatus('更新しました', 'ok');
    await refresh();
  } catch (e) {
    setStatus(`更新失敗: ${describeError(e)}`, 'err');
  }
}

async function doCancel(id: string): Promise<void> {
  if (!confirm('この予約をキャンセルしますか?')) return;
  try {
    await api.cancelReservation(id);
    setStatus('キャンセルしました', 'ok');
    await refresh();
  } catch (e) {
    setStatus(`キャンセル失敗: ${describeError(e)}`, 'err');
  }
}

async function doToggleOverlap(facilityId: string, allowOverlap: boolean): Promise<void> {
  try {
    const { facility } = await api.setOverlap(facilityId, allowOverlap);
    const idx = facilities.findIndex((f) => f.id === facilityId);
    if (idx >= 0) facilities[idx] = facility;
    setStatus(`「${facility.name}」 の重複可を ${allowOverlap ? 'ON' : 'OFF'} に`, 'ok');
    renderFacilityInfo();
  } catch (e) {
    setStatus(`設定失敗: ${describeError(e)}`, 'err');
    renderAdminPanel(); // チェック状態を実値に戻す
  }
}

// ── 起動 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const me = await api.me();
    currentUserId = me.userId;
    isAdmin = me.isAdmin;
    $('user').textContent = me.displayName ?? me.userId;
  } catch {
    $('app').innerHTML =
      '<p class="empty">ログインが必要です。 Cernere でログインしてからアクセスしてください。</p>';
    return;
  }
  facilities = (await api.facilities()).items;
  renderFacilityOptions();
  renderAdminPanel();
  ($('f-facility') as HTMLSelectElement).addEventListener('change', renderFacilityInfo);
  $('reserve-form').addEventListener('submit', (e) => void doCreate(e));
  $('filter-facility').addEventListener('change', () => void refresh());
  $('filter-mine').addEventListener('change', () => void refresh());
  await refresh();
}

void main();
