export function dateLabel(range: { startAt: string; endAt: string }): { date: string; time: string } {
  const start = new Date(range.startAt), end = new Date(range.endAt);
  const sameDay = start.toDateString() === end.toDateString();
  const date = (value: Date): string => value.toLocaleDateString('ja-JP', {
    ...(start.getFullYear() !== end.getFullYear() ? { year: 'numeric' as const } : {}),
    month: 'numeric', day: 'numeric', weekday: 'short',
  });
  const time = (value: Date): string => `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  return sameDay
    ? { date: date(start), time: `${time(start)}～${time(end)}` }
    : { date: `${date(start)} ${time(start)}～`, time: `${date(end)} ${time(end)}` };
}
