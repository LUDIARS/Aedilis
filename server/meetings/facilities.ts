import type { FacilitySource } from '../facility/source.ts';
import { MeetingError, type MeetingInput } from './types.ts';

/** The anonymous catalog deliberately excludes locations, equipment and reservations. */
export async function publicFacilities(source: FacilitySource): Promise<Array<{ id: string; name: string }>> {
  return (await source.listFacilities()).map(({ id, name }) => ({ id, name }));
}

export async function validateFacilities(input: MeetingInput, source?: FacilitySource): Promise<MeetingInput> {
  for (const venue of input.venues) {
    if (!venue.facilityId) continue;
    const facility = await source?.getFacility(venue.facilityId);
    if (!facility || facility.name !== venue.name) {
      throw new MeetingError(400, '施設が変更されています。施設一覧を再読込して選び直してください');
    }
  }
  return input;
}
