import { element, status } from './model.ts';

const key = 'aedilis.meeting.default-times';
let visible = new Date();
let selectedDates: () => string[] = () => [];
let toggleDate: (date: string) => void = () => {};
const pad = (n: number): string => String(n).padStart(2, '0');
export function calendarDate(date: Date): string { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
export function defaultRange(day: string): { startAt: string; endAt: string } {
  const start = element<HTMLInputElement>('default-start').value, end = element<HTMLInputElement>('default-end').value;
  if (!start || !end || start >= end) throw new Error('標準の終了時刻は開始時刻より後にしてください');
  return { startAt: new Date(`${day}T${start}`).toISOString(), endAt: new Date(`${day}T${end}`).toISOString() };
}
export function renderCalendar(): void {
  const year = visible.getFullYear(), month = visible.getMonth();
  element('calendar-month').textContent = `${year}年 ${month + 1}月`;
  const grid = element('calendar-days'); grid.replaceChildren();
  const selected = new Set(selectedDates());
  const first = new Date(year, month, 1).getDay();
  for (let n = 0; n < first; n++) { const blank = document.createElement('span'); blank.setAttribute('aria-hidden', 'true'); grid.append(blank); }
  for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day++) {
    const value = calendarDate(new Date(year, month, day)), button = document.createElement('button');
    button.type = 'button'; button.textContent = String(day); button.setAttribute('aria-label', `${year}年${month + 1}月${day}日`);
    button.setAttribute('aria-pressed', String(selected.has(value)));
    if (value === calendarDate(new Date())) button.setAttribute('aria-current', 'date');
    button.onclick = () => { try { toggleDate(value); renderCalendar(); } catch (error) { status(error instanceof Error ? error.message : '日付を選択できません', true); } };
    grid.append(button);
  }
  element('calendar-count').textContent = `${selected.size}日を選択中`;
}
export function showCalendarMonth(day?: string): void {
  visible = day ? new Date(`${day}T12:00`) : new Date(); renderCalendar();
}
export function setupCalendar(dates: () => string[], toggle: (date: string) => void): void {
  selectedDates = dates; toggleDate = toggle;
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const times = JSON.parse(saved) as { start?: string; end?: string };
      if (/^\d{2}:\d{2}$/.test(times.start ?? '') && /^\d{2}:\d{2}$/.test(times.end ?? '') && times.start && times.end && times.start < times.end) {
        element<HTMLInputElement>('default-start').value = times.start; element<HTMLInputElement>('default-end').value = times.end;
      }
    }
  } catch { status('標準時刻の保存設定を読み込めません。この画面で時刻を設定してください', true); }
  element('save-default-times').onclick = () => {
    try {
      defaultRange(calendarDate(new Date()));
      localStorage.setItem(key, JSON.stringify({ start: element<HTMLInputElement>('default-start').value, end: element<HTMLInputElement>('default-end').value }));
      status('標準時刻をこの端末に保存しました。追加する日付に適用されます');
    } catch (error) { status(error instanceof Error ? error.message : '標準時刻を保存できません', true); }
  };
  element('calendar-prev').onclick = () => { visible = new Date(visible.getFullYear(), visible.getMonth() - 1, 1); renderCalendar(); };
  element('calendar-next').onclick = () => { visible = new Date(visible.getFullYear(), visible.getMonth() + 1, 1); renderCalendar(); };
  renderCalendar();
}
