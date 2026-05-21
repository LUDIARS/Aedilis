// Aedilis API クライアント。 認証は Cernere の cernere_token cookie に依存
// (credentials: 'include' で送出)。 401 は呼び出し側でログイン誘導に使う。

export interface Me {
  userId: string;
  displayName: string | null;
  role: string;
  isAdmin: boolean;
}

export interface Facility {
  id: string;
  name: string;
  location?: string;
  capacity?: number;
  equipment?: string[];
  allowOverlap: boolean;
}

export interface Reservation {
  id: string;
  facility_id: string;
  owner_user_id: string;
  start_at: number;
  end_at: number;
  purpose: string;
  state: string;
  facility_name: string | null;
  owner_display_name: string | null;
}

export interface ApiError {
  status: number;
  body: { error?: string; code?: string };
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ApiError['body'];
    throw { status: res.status, body } satisfies ApiError;
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => req<Me>('/api/me'),
  facilities: () => req<{ items: Facility[] }>('/api/facilities'),
  reservations: (query: string) =>
    req<{ items: Reservation[] }>(`/api/reservations${query}`),
  myReservations: () => req<{ items: Reservation[] }>('/api/reservations/mine'),
  createReservation: (body: {
    facilityId: string;
    startAt: string;
    endAt: string;
    purpose: string;
  }) =>
    req<{ reservation: Reservation }>('/api/reservations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateReservation: (
    id: string,
    body: { startAt?: string; endAt?: string; purpose?: string },
  ) =>
    req<{ reservation: Reservation }>(`/api/reservations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  cancelReservation: (id: string) =>
    req<{ reservation: Reservation }>(`/api/reservations/${id}`, {
      method: 'DELETE',
    }),
  setOverlap: (facilityId: string, allowOverlap: boolean) =>
    req<{ facility: Facility }>(`/api/facilities/${facilityId}/overlap`, {
      method: 'POST',
      body: JSON.stringify({ allowOverlap }),
    }),
};
