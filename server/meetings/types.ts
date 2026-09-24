export interface TimeRange { startAt: string; endAt: string }
export interface Candidate extends TimeRange { id: string; venue: string }
export interface Venue { name: string; busy: TimeRange[]; facilityId?: string }
export interface MeetingInput {
  title: string;
  description: string;
  organizerName: string;
  onlineAllowed: boolean;
  slots: Candidate[];
  venues: Venue[];
}
export interface ResponseInput {
  name: string;
  comment: string;
  topic: string;
  answers: Record<string, 'yes' | 'maybe' | 'no'>;
  defaultOnline?: boolean;
  online?: Record<string, boolean>;
}
export interface IdentityRow { id: string; user_id: string | null; notify: number }
export interface MeetingRow {
  id: string; owner_id: string; title: string; description: string;
  organizer_name: string; online_allowed: number; slots_json: string; venues_json: string;
  state: 'open' | 'finalized' | 'cancelled'; selected_slot: string | null;
  revision: number; created_at: number; updated_at: number;
}
export interface ResponseRow {
  id: string; meeting_id: string; owner_id: string; name: string;
  comment: string; topic: string; answers_json: string; revision: number;
  default_online: number; online_json: string;
}
export interface Actor { identities: IdentityRow[]; current: IdentityRow | null; userId: string | null }
export class MeetingError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503, message: string) {
    super(message);
  }
}
