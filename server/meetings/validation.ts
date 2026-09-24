import { MeetingError, type Candidate, type MeetingInput, type ResponseInput, type TimeRange } from './types.ts';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MeetingError(400, '入力形式が不正です');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new MeetingError(400, `文字数・必須項目を確認してください（最大${max}文字）`);
  }
  return value.trim();
}
function range(value: unknown): TimeRange {
  const r = object(value);
  const start = text(r.startAt, 40, true), end = text(r.endAt, 40, true);
  // Offsets are mandatory: a timezone-less string has host-dependent semantics.
  const withZone = /T.*(?:Z|[+-]\d{2}:\d{2})$/;
  const a = Date.parse(start), b = Date.parse(end);
  if (!withZone.test(start) || !withZone.test(end) || !Number.isFinite(a) || !Number.isFinite(b) || a >= b || b - a > 31 * 86400000) {
    throw new MeetingError(400, '開始・終了日時を確認してください');
  }
  return { startAt: new Date(a).toISOString(), endAt: new Date(b).toISOString() };
}
export function meetingInput(value: unknown): MeetingInput {
  const r = object(value);
  if (!Array.isArray(r.slots) || r.slots.length < 1 || r.slots.length > 100 || !Array.isArray(r.venues) || r.venues.length > 30) {
    throw new MeetingError(400, '候補は1〜100件、会場は30件以内です');
  }
  const venues = r.venues.map(v => {
    const o = object(v);
    if (!Array.isArray(o.busy) || o.busy.length > 200) throw new MeetingError(400, '会場の予定が多すぎます');
    return { name: text(o.name, 100, true), busy: o.busy.map(range) };
  });
  if (new Set(venues.map(v => v.name)).size !== venues.length) throw new MeetingError(400, '会場名が重複しています');
  const slots = r.slots.map(s => {
    const o = object(s), id = text(o.id, 64, true), venue = text(o.venue, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new MeetingError(400, '候補IDが不正です');
    if (venue && !venues.some(v => v.name === venue)) throw new MeetingError(400, '候補の会場を登録してください');
    return { ...range(o), id, venue };
  });
  if (new Set(slots.map(s => s.id)).size !== slots.length) throw new MeetingError(400, '候補IDが重複しています');
  return { title: text(r.title, 150, true), description: text(r.description, 3000), organizerName: text(r.organizerName, 80, true), slots, venues };
}
export function responseInput(value: unknown, slots: Candidate[]): ResponseInput {
  const r = object(value), answers = object(r.answers);
  if (Object.keys(answers).some(id => !slots.some(s => s.id === id))) throw new MeetingError(400, '候補が変更されています。再読込してください');
  const normalized: ResponseInput['answers'] = Object.create(null) as ResponseInput['answers'];
  for (const slot of slots) {
    const a = answers[slot.id];
    if (a !== 'yes' && a !== 'maybe' && a !== 'no') throw new MeetingError(400, 'すべての候補に回答してください');
    normalized[slot.id] = a;
  }
  return { name: text(r.name, 80, true), comment: text(r.comment, 2000), topic: text(r.topic, 2000), answers: normalized };
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new MeetingError(400, '版番号が不正です');
  return Number(value);
}
