// 出席イベント webhook (CONTRACTS §5)。
//
// env MEMORIA_WEBHOOK_URL が設定されている時のみ POST する (fire-and-forget)。
//
// 【既定の向き先 = relay】 この URL は Memoria を直接叩くのではなく
// **Imperativus / Legatus relay の出席エンドポイント** を指すのが正
// (relay → Memoria ingest で presence/attendance ログとして 1 件追加される)。
// Memoria は online 直接 write 不可 ([[feedback_memoria_online_flow]]) なので、
// 直 Memoria URL を入れる構成にはしないこと。 コードは渡された URL に POST する
// だけで宛先を強制しないが、運用上の正は relay 経由。
// 配線詳細は spec/setup/webauthn-rp-id.md §6 / README「出席チェックイン用」節。
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
