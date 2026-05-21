// LocalFacilitySource — JSON ファイルから施設マスタを読む暫定実装。
//
// ファイルは起動時に 1 回読み込み、 メモリに保持する。 ファイルが無い /
// 壊れている場合は空リストで graceful degrade (= 起動は止めない)。

import { readFileSync } from 'node:fs';
import type { Facility, FacilitySource } from './source.ts';

function parseFacilities(raw: unknown): Facility[] {
  if (!Array.isArray(raw)) return [];
  const out: Facility[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.name !== 'string') continue;
    out.push({
      id: o.id,
      name: o.name,
      location: typeof o.location === 'string' ? o.location : undefined,
      capacity: typeof o.capacity === 'number' ? o.capacity : undefined,
      equipment: Array.isArray(o.equipment)
        ? o.equipment.filter((e): e is string => typeof e === 'string')
        : undefined,
      allowOverlap: o.allowOverlap === true,
    });
  }
  return out;
}

export class LocalFacilitySource implements FacilitySource {
  readonly sourceName = 'local';
  private facilities: Map<string, Facility>;

  constructor(jsonPath: string) {
    let parsed: Facility[] = [];
    try {
      parsed = parseFacilities(JSON.parse(readFileSync(jsonPath, 'utf-8')));
      console.log(
        `[facility] LocalFacilitySource: ${parsed.length} 件 (${jsonPath})`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[facility] 施設マスタ JSON を読めません (${jsonPath}): ${msg} — 空で起動`,
      );
    }
    this.facilities = new Map(parsed.map((f) => [f.id, f]));
  }

  listFacilities(): Promise<Facility[]> {
    return Promise.resolve([...this.facilities.values()]);
  }

  getFacility(id: string): Promise<Facility | null> {
    return Promise.resolve(this.facilities.get(id) ?? null);
  }
}
