import { element, escape, status, type Venue } from './model.ts';
import { facilityVenue } from './facilities.ts';

const storageKey = 'aedilis.meeting.default-venue';
export function savedVenue(): string {
  try { return localStorage.getItem(storageKey) || ''; }
  catch { status('標準会場を読み込めませんでした。この画面では会場を選択できます。', true); return ''; }
}
export function savedVenueDraft(): Venue | undefined {
  try {
    const id = localStorage.getItem(`${storageKey}.facility-id`);
    if (id) {
      const venue = facilityVenue(id);
      if (!venue) status('保存した標準施設を取得できません。施設一覧から選び直してください。', true);
      return venue;
    }
    const name = savedVenue();
    return name ? { name, busy: [] } : undefined;
  } catch { status('標準施設を読み込めませんでした。', true); return undefined; }
}
export function selectedVenue(): string { return element<HTMLSelectElement>('default-venue').value; }
export function refreshDefaultVenue(names: string[]): void {
  const select = element<HTMLSelectElement>('default-venue'), previous = select.value;
  select.innerHTML = '<option value="">会場未定</option>' + names.map(name => `<option value="${escape(name)}">${escape(name)}</option>`).join('');
  select.value = names.includes(previous) ? previous : '';
}
export function restoreDefaultVenue(): void {
  const select = element<HTMLSelectElement>('default-venue'), saved = savedVenueDraft()?.name || '';
  select.value = [...select.options].some(option => option.value === saved) ? saved : '';
}
export function setupDefaultVenue(venues: () => Venue[]): void {
  element('save-default-venue').addEventListener('click', () => {
    try {
      const selected = selectedVenue();
      const venue = venues().find(item => item.name === selected);
      localStorage.setItem(`${storageKey}.facility-id`, venue?.facilityId || '');
      localStorage.setItem(storageKey, selected);
      status('標準会場をこの端末に保存しました。新しく追加する候補に適用します。');
    }
    catch { status('標準会場を保存できませんでした。', true); }
  });
}
