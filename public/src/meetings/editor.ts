import { element, escape, localInput, type MeetingDraft, type Range, type Slot, type Venue } from './model.ts';

function input(row: Element, selector: string): HTMLInputElement { return row.querySelector<HTMLInputElement>(selector) as HTMLInputElement; }
function iso(value: string): string { return new Date(value).toISOString(); }
function timeFields(range?: Range): string {
  return `<div class="row"><label>開始<input class="start" type="datetime-local" required value="${range ? localInput(range.startAt) : ''}"></label><label>終了<input class="end" type="datetime-local" required value="${range ? localInput(range.endAt) : ''}"></label></div>`;
}
export function venueNames(): string[] {
  return [...element('venues').querySelectorAll<HTMLInputElement>('.venue-name')].map(i => i.value.trim()).filter(Boolean);
}
export function refreshVenues(): void {
  const names = venueNames();
  for (const select of element('slots').querySelectorAll<HTMLSelectElement>('select')) {
    const selected = select.value;
    select.innerHTML = '<option value="">未定・オンライン</option>' + names.map(n => `<option value="${escape(n)}">${escape(n)}</option>`).join('');
    select.value = names.includes(selected) ? selected : '';
  }
  const target = element<HTMLSelectElement>('google-target'), selected = target.value;
  target.innerHTML = '<option value="slots">候補日時</option>' + names.map(n => `<option value="venue:${escape(n)}">${escape(n)} の利用不可時間</option>`).join('');
  if ([...target.options].some(o => o.value === selected)) target.value = selected;
}
export function addSlot(value?: Slot): void {
  const row = document.createElement('div'); row.className = 'slot-row'; row.dataset.id = value?.id || crypto.randomUUID();
  row.innerHTML = `${timeFields(value)}<label>会場<select></select></label><button type="button" class="remove">候補を削除</button>`;
  row.querySelector('button')?.addEventListener('click', () => row.remove());
  element('slots').append(row); refreshVenues();
  if (value) (row.querySelector('select') as HTMLSelectElement).value = value.venue;
}
function addBusy(container: HTMLElement, range?: Range): void {
  const row = document.createElement('div'); row.className = 'busy-row';
  row.innerHTML = `${timeFields(range)}<button type="button">利用不可時間を削除</button>`;
  row.querySelector('button')?.addEventListener('click', () => row.remove()); container.append(row);
}
export function addVenue(value?: Venue): void {
  const row = document.createElement('div'); row.className = 'venue-row';
  row.innerHTML = `<label>会場名<input class="venue-name" maxlength="100" required value="${escape(value?.name || '')}"></label><div class="busy-list"></div><div class="actions"><button type="button" class="add-busy">＋ 利用不可時間</button><button type="button" class="remove">会場を削除</button></div>`;
  const busy = row.querySelector<HTMLElement>('.busy-list') as HTMLElement;
  row.querySelector('.add-busy')?.addEventListener('click', () => addBusy(busy));
  row.querySelector('.remove')?.addEventListener('click', () => { row.remove(); refreshVenues(); });
  row.querySelector('input')?.addEventListener('change', refreshVenues);
  for (const period of value?.busy || []) addBusy(busy, period);
  element('venues').append(row); refreshVenues();
}
export function importRanges(ranges: Range[], target: string): void {
  if (target === 'slots') {
    for (const r of ranges) addSlot({ ...r, id: crypto.randomUUID(), venue: '' });
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
  element<HTMLTextAreaElement>('description').value = draft?.description || '';
  element('venues').replaceChildren(); element('slots').replaceChildren();
  for (const v of draft?.venues || []) addVenue(v);
  for (const s of draft?.slots || []) addSlot(s);
  if (!draft) addSlot();
  refreshVenues();
}
export function readEditor(): MeetingDraft {
  const slots = [...element('slots').querySelectorAll<HTMLElement>('.slot-row')].map(row => ({
    id: row.dataset.id || crypto.randomUUID(), startAt: iso(input(row, '.start').value), endAt: iso(input(row, '.end').value), venue: (row.querySelector('select') as HTMLSelectElement).value,
  }));
  const venues = [...element('venues').querySelectorAll<HTMLElement>('.venue-row')].map(row => ({
    name: input(row, '.venue-name').value.trim(), busy: [...row.querySelectorAll('.busy-row')].map(b => ({ startAt: iso(input(b, '.start').value), endAt: iso(input(b, '.end').value) })),
  }));
  return { title: element<HTMLInputElement>('title').value, organizerName: element<HTMLInputElement>('organizer').value, description: element<HTMLTextAreaElement>('description').value, slots, venues };
}
