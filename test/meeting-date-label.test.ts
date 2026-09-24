import { describe, expect, it } from 'vitest';
import { dateLabel } from '../public/src/meetings/date-label.ts';

describe('meeting date label in the viewer local timezone', () => {
  it('shows one date and only times for a same-day meeting', () => {
    const result = dateLabel({ startAt: new Date(2026, 8, 24, 13, 30).toISOString(), endAt: new Date(2026, 8, 24, 17, 30).toISOString() });
    expect(result.date).toContain('9/24');
    expect(result.time).toBe('13:30～17:30');
  });
  it('keeps both dates across midnight', () => {
    const result = dateLabel({ startAt: new Date(2026, 8, 24, 23, 30).toISOString(), endAt: new Date(2026, 8, 25, 1, 0).toISOString() });
    expect(result.date).toContain('9/24');
    expect(result.date).toContain('23:30');
    expect(result.time).toContain('9/25');
    expect(result.time).toContain('01:00');
  });
  it('distinguishes years for a meeting spanning New Year', () => {
    const result = dateLabel({ startAt: new Date(2026, 11, 31, 23, 0).toISOString(), endAt: new Date(2027, 0, 1, 1, 0).toISOString() });
    expect(result.date).toContain('2026');
    expect(result.time).toContain('2027');
  });
});
