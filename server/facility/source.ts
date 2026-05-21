// 施設マスタソースの抽象。
//
// 施設の「中身」(名前 / 場所 / 定員 / 備品) は Aedilis が直接持たない。
// Bibliotheca の MasterSource と同型のパターン。 v0.2 は LocalFacilitySource
// (JSON ファイル) のみ。 将来 Cernere / Schedula / 専用マスタ DB ができたら
// 別実装を足して差し替える。

export interface Facility {
  /** 施設の不変 ID。 予約レコードはこれを参照する。 */
  id: string;
  name: string;
  location?: string;
  capacity?: number;
  equipment?: string[];
  /** true の施設は同一時間帯の重複予約を許す (§3.4)。 */
  allowOverlap?: boolean;
}

export interface FacilitySource {
  /** facility_cache.source に入る識別子 ('local' 等)。 */
  readonly sourceName: string;
  listFacilities(): Promise<Facility[]>;
  getFacility(id: string): Promise<Facility | null>;
}
