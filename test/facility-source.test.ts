// LocalFacilitySource のテスト — JSON ファイルからの施設マスタ読み込み。
// ファイル欠損 / 壊れた行は graceful degrade する設計を検証する。

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFacilitySource } from '../server/facility/local.ts';

const tmpDirs: string[] = [];

/** facilities.json を一時ファイルに書き出し、 そのパスを返す。 */
function writeFacilitiesJson(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'aedilis-test-'));
  tmpDirs.push(dir);
  const path = join(dir, 'facilities.json');
  writeFileSync(path, JSON.stringify(content), 'utf-8');
  return path;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('LocalFacilitySource', () => {
  it('loads facilities from a valid JSON file', async () => {
    const src = new LocalFacilitySource(
      writeFacilitiesJson([
        { id: 'room-a', name: 'Room A' },
        { id: 'room-b', name: 'Room B' },
      ]),
    );
    expect(await src.listFacilities()).toHaveLength(2);
    expect((await src.getFacility('room-a'))?.name).toBe('Room A');
  });

  it('degrades to an empty list when the file is missing', async () => {
    const src = new LocalFacilitySource(
      join(tmpdir(), 'aedilis-no-such-facilities-file.json'),
    );
    expect(await src.listFacilities()).toEqual([]);
  });

  it('skips entries missing id or name', async () => {
    const src = new LocalFacilitySource(
      writeFacilitiesJson([
        { id: 'ok', name: 'OK' },
        { id: 'no-name-here' },
        { name: 'no id here' },
        {},
        'not-an-object',
        null,
      ]),
    );
    const list = await src.listFacilities();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('ok');
  });

  it('treats allowOverlap as true only when strictly boolean true', async () => {
    const src = new LocalFacilitySource(
      writeFacilitiesJson([
        { id: 'a', name: 'A', allowOverlap: true },
        { id: 'b', name: 'B', allowOverlap: 'true' },
        { id: 'c', name: 'C' },
      ]),
    );
    expect((await src.getFacility('a'))?.allowOverlap).toBe(true);
    expect((await src.getFacility('b'))?.allowOverlap).toBe(false);
    expect((await src.getFacility('c'))?.allowOverlap).toBe(false);
  });

  it('parses optional location / capacity / equipment fields', async () => {
    const src = new LocalFacilitySource(
      writeFacilitiesJson([
        {
          id: 'a',
          name: 'A',
          location: '2F',
          capacity: 10,
          equipment: ['projector', 'wifi'],
        },
      ]),
    );
    const facility = await src.getFacility('a');
    expect(facility?.location).toBe('2F');
    expect(facility?.capacity).toBe(10);
    expect(facility?.equipment).toEqual(['projector', 'wifi']);
  });

  it('returns null for an unknown facility id', async () => {
    const src = new LocalFacilitySource(
      writeFacilitiesJson([{ id: 'a', name: 'A' }]),
    );
    expect(await src.getFacility('does-not-exist')).toBeNull();
  });

  it('reports its source name as "local"', () => {
    const src = new LocalFacilitySource(
      writeFacilitiesJson([{ id: 'a', name: 'A' }]),
    );
    expect(src.sourceName).toBe('local');
  });
});
