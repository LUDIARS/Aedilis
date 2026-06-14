// Memoria 出席イベント webhook (CONTRACTS §5)。
//
// env MEMORIA_WEBHOOK_URL が設定されている時のみ POST する (fire-and-forget)。
// Memoria は online 直接 write 不可 ([[feedback_memoria_online_flow]]) なので、
// この URL は **Imperativus relay の受け口** を指す前提 (presence/attendance ログ
// として 1 件追加される)。 直接 Memoria を叩く構成にはしないこと。
//
// 失敗は warn のみ。 出席記録そのものは成功扱いにする (通知は副次的)。

export interface AttendanceEvent {
  userId: string;
  facilityId: string;
  checkedInAt: number;
  reservationId: string | null;
}

/** 出席イベントを Memoria (relay) へ送る。 await しない。 個人データは userId のみ。 */
export function notifyAttendance(event: AttendanceEvent): void {
  const url = process.env.MEMORIA_WEBHOOK_URL;
  if (!url || !url.trim()) return; // 未設定 → 送らない (CONTRACTS §4 env)

  const payload = {
    type: 'attendance.checked_in' as const,
    userId: event.userId,
    facilityId: event.facilityId,
    checkedInAt: event.checkedInAt,
    reservationId: event.reservationId,
    source: 'aedilis' as const,
  };

  void fetch(url.trim(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((res) => {
      if (!res.ok) {
        console.warn(`[checkin] memoria webhook non-2xx: ${res.status}`);
      }
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[checkin] memoria webhook failed: ${msg}`);
    });
}
