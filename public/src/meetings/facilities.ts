import { action, element, escape, request, status, type Venue } from './model.ts';

let facilities: Array<{ id: string; name: string }> = [];
export function facilityVenue(id: string): Venue | undefined {
  const facility = facilities.find(item => item.id === id);
  return facility ? { name: facility.name, facilityId: facility.id, busy: [] } : undefined;
}
export async function setupFacilities(add: (venue: Venue) => void): Promise<void> {
  const select = element<HTMLSelectElement>('facility-choice');
  const button = element<HTMLButtonElement>('add-facility');
  const load = async (): Promise<void> => {
    button.disabled = true;
    try {
      const result = await request<{ items: Array<{ id: string; name: string }> }>('/facilities');
      facilities = result.items;
      select.innerHTML = '<option value="">施設を選択</option>' + facilities.map(f => `<option value="${escape(f.id)}">${escape(f.name)}</option>`).join('');
      element('facility-help').textContent = facilities.length ? 'Aeの施設を会場に追加できます。施設の予約確保は別途必要です。' : '登録された施設はありません。会場名は手入力できます。';
      button.disabled = facilities.length === 0;
    } catch {
      element('facility-help').textContent = '施設一覧を取得できませんでした。再読込するか会場名を手入力してください。';
    }
  };
  button.onclick = () => {
    const venue = facilityVenue(select.value);
    if (!venue) { status('施設を選んでください', true); return; }
    add(venue);
  };
  element('reload-facilities').onclick = () => { void action(load); };
  await load();
}
