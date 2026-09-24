import { element, escape, status } from './model.ts';

const storageKey = 'aedilis.meeting.default-venue';
export function savedVenue(): string {
  try { return localStorage.getItem(storageKey) || ''; }
  catch { status('標準会場を読み込めませんでした。この画面では会場を選択できます。', true); return ''; }
}
export function selectedVenue(): string { return element<HTMLSelectElement>('default-venue').value; }
export function refreshDefaultVenue(names: string[]): void {
  const select = element<HTMLSelectElement>('default-venue'), previous = select.value;
  select.innerHTML = '<option value="">会場未定</option>' + names.map(name => `<option value="${escape(name)}">${escape(name)}</option>`).join('');
  select.value = names.includes(previous) ? previous : '';
}
export function restoreDefaultVenue(): void {
  const select = element<HTMLSelectElement>('default-venue'), saved = savedVenue();
  select.value = [...select.options].some(option => option.value === saved) ? saved : '';
}
export function setupDefaultVenue(): void {
  element('save-default-venue').addEventListener('click', () => {
    try { localStorage.setItem(storageKey, selectedVenue()); status('標準会場をこの端末に保存しました。新しく追加する候補に適用します。'); }
    catch { status('標準会場を保存できませんでした。', true); }
  });
}
