import { setupCalendar, renderCalendar, showCalendarMonth, defaultRange } from './calendar.ts';
import { setupDefaultVenue, refreshDefaultVenue, restoreDefaultVenue, savedVenueDraft, selectedVenue } from './venue-default.ts';
import { element, escape, localInput, status, type MeetingDraft, type Range, type Slot, type Venue } from './model.ts';

function input(row: Element, selector: string): HTMLInputElement { return row.querySelector<HTMLInputElement>(selector) as HTMLInputElement; }
function iso(value: string): string { return new Date(value).toISOString(); }
export function setupDatePicker(): void {
  setupDefaultVenue(() => [...element('venues').querySelectorAll<HTMLElement>('.venue-row')].map(row => ({
    name: input(row, '.venue-name').value.trim(), busy: [], facilityId: row.dataset.facilityId,
  })));
  const rows = (): HTMLElement[] => [...element('slots').querySelectorAll<HTMLElement>('.slot-row')];
  setupCalendar(() => rows().map(row => input(row, '.start').value.slice(0, 10)).filter(Boolean), day => {
    const matches = rows().filter(row => input(row, '.start').value.startsWith(day));
    if (matches.length) { for (const row of matches) row.remove(); }
    else addSlot({ id: crypto.randomUUID(), ...defaultRange(day), venue: selectedVenue() });
  });
}
function timeFields(range?: Range): string {
  return `<div class="row"><label>開始<input class="start" type="datetime-local" required value="${range ? localInput(range.startAt) : ''}"></label><label>終了<input class="end" type="datetime-local" required value="${range ? localInput(range.endAt) : ''}"></label></div>`;
}
export function venueNames(): string[] {
  return [...element('venues').querySelectorAll<HTMLInputElement>('.venue-name')].map(i => i.value.trim()).filter(Boolean);
}
export function refreshVenues(): void {
  const names = venueNames();
  refreshDefaultVenue(names);
  for (const select of element('slots').querySelectorAll<HTMLSelectElement>('select')) {
    const selected = select.value;
    select.innerHTML = '<option value="">会場未定</option>' + names.map(n => `<option value="${escape(n)}">${escape(n)}</option>`).join('');
    select.value = names.includes(selected) ? selected : '';
  }
  const target = element<HTMLSelectElement>('google-target'), selected = target.value;
  target.innerHTML = '<option value="slots">候補日時</option>' + names.map(n => `<option value="venue:${escape(n)}">${escape(n)} の利用不可時間</option>`).join('');
  if ([...target.options].some(o => o.value === selected)) target.value = selected;
}
export function addSlot(value?: Slot): void {
  const row = document.createElement('div'); row.className = 'slot-row'; row.dataset.id = value?.id || crypto.randomUUID();
  row.innerHTML = `${timeFields(value)}<label>会場<select></select></label><button type="button" class="remove">候補を削除</button>`;
  row.querySelector('button')?.addEventListener('click', () => { row.remove(); renderCalendar(); });
  row.querySelector('.start')?.addEventListener('change', renderCalendar);
  element('slots').append(row); refreshVenues(); renderCalendar();
  if (value) (row.querySelector('select') as HTMLSelectElement).value = value.venue;
}
function addBusy(container: HTMLElement, range?: Range): void {
  const row = document.createElement('div'); row.className = 'busy-row';
  row.innerHTML = `${timeFields(range)}<button type="button">利用不可時間を削除</button>`;
  row.querySelector('button')?.addEventListener('click', () => row.remove()); container.append(row);
}
export function addVenue(value?: Venue): void {
  if (value?.facilityId && [...element('venues').querySelectorAll<HTMLElement>('.venue-row')].some(row => row.dataset.facilityId === value.facilityId || input(row, '.venue-name').value.trim() === value.name)) {
    status('同じ施設または同名の会場が登録されています。既存の会場を確認してください。', true); return;
  }
  const row = document.createElement('div'); row.className = 'venue-row';
  if (value?.facilityId) row.dataset.facilityId = value.facilityId;
  row.innerHTML = `<label>会場名<input class="venue-name" maxlength="100" required value="${escape(value?.name || '')}"></label><div class="busy-list"></div><div class="actions"><button type="button" class="add-busy">＋ 利用不可時間</button><button type="button" class="remove">会場を削除</button></div>`;
  const busy = row.querySelector<HTMLElement>('.busy-list') as HTMLElement;
  if (value?.facilityId) {
    input(row, '.venue-name').readOnly = true;
    const note = document.createElement('p'); note.textContent = 'Ae登録施設'; row.prepend(note);
  }
  row.querySelector('.add-busy')?.addEventListener('click', () => addBusy(busy));
  row.querySelector('.remove')?.addEventListener('click', () => { row.remove(); refreshVenues(); });
  row.querySelector('input')?.addEventListener('change', refreshVenues);
  for (const period of value?.busy || []) addBusy(busy, period);
  element('venues').append(row); refreshVenues();
}
export function importRanges(ranges: Range[], target: string): void {
  if (target === 'slots') {
    for (const r of ranges) addSlot({ ...r, id: crypto.randomUUID(), venue: selectedVenue() });
    return;
  }
  const name = target.slice('venue:'.length);
  const row = [...element('venues').querySelectorAll<HTMLElement>('.venue-row')].find(v => input(v, '.venue-name').value.trim() === name);
  if (!row) throw new Error('取り込み先の会場を選んでください');
  const busy = row.querySelector<HTMLElement>('.busy-list') as HTMLElement;
  for (const r of ranges) addBusy(busy, r);
}
export function fillEditor(draft?: MeetingDraft): void {
  element<HTMLInputElement>('title').value = draft?.title || '';
  element<HTMLInputElement>('organizer').value = draft?.organizerName || '';
  element<HTMLInputElement>('online-allowed').checked = draft?.onlineAllowed ?? false;
  element<HTMLTextAreaElement>('description').value = draft?.description || '';
  element('venues').replaceChildren(); element('slots').replaceChildren();
  if (!draft) {
    const venue = savedVenueDraft();
    if (venue) addVenue(venue);
  }
  for (const v of draft?.venues || []) addVenue(v);
  for (const s of draft?.slots || []) addSlot(s);
  showCalendarMonth(draft?.slots[0] ? localInput(draft.slots[0].startAt).slice(0, 10) : undefined);
  refreshVenues();
  restoreDefaultVenue();
}
function readVenues(): Venue[] {
  return [...element('venues').querySelectorAll<HTMLElement>('.venue-row')].map(row => ({
    name: input(row, '.venue-name').value.trim(), busy: [...row.querySelectorAll('.busy-row')].map(b => ({ startAt: iso(input(b, '.start').value), endAt: iso(input(b, '.end').value) })),
    ...(row.dataset.facilityId ? { facilityId: row.dataset.facilityId } : {}),
  }));
}
export function readEditor(): MeetingDraft {
  const slots = [...element('slots').querySelectorAll<HTMLElement>('.slot-row')].map(row => ({
    id: row.dataset.id || crypto.randomUUID(), startAt: iso(input(row, '.start').value), endAt: iso(input(row, '.end').value), venue: (row.querySelector('select') as HTMLSelectElement).value,
  }));
  const venues = readVenues();
  return { title: element<HTMLInputElement>('title').value, organizerName: element<HTMLInputElement>('organizer').value, onlineAllowed: element<HTMLInputElement>('online-allowed').checked, description: element<HTMLTextAreaElement>('description').value, slots, venues };
}
