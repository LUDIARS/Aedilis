// Corpus 連携 — サービスマニフェスト + 宣言的 UI descriptor。
//
// Corpus (LUDIARS の hub) は GET /.well-known/corpus-service.json を読み、
// declarative panel の descriptor を内蔵レンダラで描く (Corpus DESIGN.md §13)。
// Aedilis は Corpus 宣言的レンダリングの **pilot** — 自前 SPA はこれと別に
// 当面残す (本マニフェスト追加は非破壊)。
//
// 注: corpusApi 2 / kind:'declarative' は Corpus 側 §13 実装 (未) を前提とする
// 先行宣言。 現行 Corpus は declarative panel を無視する (entry 必須の normalize)。

// ── マニフェスト型 (Corpus server/hub/manifest.ts のミラー + §13 拡張) ──────

interface ManifestDataEndpoint {
  id: string;
  /** サービス内のパス。 :param を含めてよい (action の params で埋める)。 */
  path: string;
  scope: 'local' | 'multi';
  title?: string;
}

// ── UI descriptor 型 (Corpus DESIGN.md §13) ────────────────────────────────
//
// テンプレート文字列は `{field}` / `{field|filter}` 置換、 または素のテキスト。

interface ActionDescriptor {
  label: string;
  dataId: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  params?: Record<string, string>;
  body?: Record<string, string>;
  confirm?: string;
  success?: string;
  requires?: 'admin';
}

interface FormField {
  name: string;
  label: string;
  input: 'text' | 'textarea' | 'number' | 'select' | 'datetime' | 'date' | 'checkbox';
  required?: boolean;
  maxLength?: number;
  /** input='select' のとき、 選択肢を引く data id。 */
  optionsSource?: string;
  /** 選択肢レスポンス内の配列パス (例 'items')。 */
  optionsPath?: string;
  optionLabel?: string;
  optionValue?: string;
}

interface FormComponent {
  type: 'form';
  submit: { dataId: string; method: 'POST' | 'PATCH'; success?: string };
  fields: FormField[];
}

interface ListComponent {
  type: 'list';
  dataSource: string;
  itemsPath?: string;
  itemKey: string;
  empty?: string;
  item: {
    title: string;
    subtitle?: string;
    body?: string;
    meta?: string;
    actions?: ActionDescriptor[];
  };
}

interface TableComponent {
  type: 'table';
  dataSource: string;
  itemsPath?: string;
  columns: { header: string; value: string }[];
  rowActions?: ActionDescriptor[];
}

type ComponentDescriptor = FormComponent | ListComponent | TableComponent;

interface SectionDescriptor {
  title?: string;
  components: ComponentDescriptor[];
}

interface PanelDescriptor {
  descriptorVersion: 1;
  title: string;
  sections: SectionDescriptor[];
}

interface DeclarativePanel {
  id: string;
  kind: 'declarative';
  title: string;
  icon?: string;
  ui: PanelDescriptor;
}

export interface CorpusServiceManifest {
  service: string;
  displayName: string;
  version: string;
  corpusApi: number;
  health: string;
  auth: string;
  cernereProjectKey?: string;
  data: ManifestDataEndpoint[];
  panels: DeclarativePanel[];
}

// ── Aedilis の宣言的 UI descriptor ─────────────────────────────────────────

const reservationPanel: PanelDescriptor = {
  descriptorVersion: 1,
  title: '施設予約',
  sections: [
    {
      title: '新規予約',
      components: [
        {
          type: 'form',
          submit: { dataId: 'reservations', method: 'POST', success: '予約しました' },
          fields: [
            {
              name: 'facilityId',
              label: '施設',
              input: 'select',
              required: true,
              optionsSource: 'facilities',
              optionsPath: 'items',
              optionLabel: 'name',
              optionValue: 'id',
            },
            { name: 'startAt', label: '開始', input: 'datetime', required: true },
            { name: 'endAt', label: '終了', input: 'datetime', required: true },
            { name: 'purpose', label: '目的', input: 'text', maxLength: 200 },
          ],
        },
      ],
    },
    {
      title: '予約一覧',
      components: [
        {
          type: 'list',
          dataSource: 'reservations',
          itemsPath: 'items',
          itemKey: 'id',
          empty: '予約はありません',
          item: {
            title: '{facility_name}',
            subtitle: '{start_at|datetime}–{end_at|time}',
            body: '{purpose}',
            meta: '{owner_display_name}',
            actions: [
              {
                label: 'キャンセル',
                dataId: 'reservation',
                method: 'DELETE',
                params: { id: '{id}' },
                confirm: 'この予約をキャンセルしますか?',
                success: 'キャンセルしました',
              },
            ],
          },
        },
      ],
    },
    {
      title: '施設一覧',
      components: [
        {
          type: 'table',
          dataSource: 'facilities',
          itemsPath: 'items',
          columns: [
            { header: '施設', value: '{name}' },
            { header: '場所', value: '{location}' },
            { header: '定員', value: '{capacity}' },
          ],
        },
      ],
    },
  ],
};

// ── サービスマニフェスト ────────────────────────────────────────────────────

export const CORPUS_MANIFEST_PATH = '/.well-known/corpus-service.json';

export const corpusManifest: CorpusServiceManifest = {
  service: 'aedilis',
  displayName: 'Aedilis 施設予約',
  version: '0.2.0',
  corpusApi: 2,
  health: '/api/health',
  auth: 'cernere-project-token',
  cernereProjectKey: 'aedilis',
  data: [
    { id: 'facilities', path: '/api/facilities', scope: 'local', title: '施設' },
    { id: 'reservations', path: '/api/reservations', scope: 'local', title: '予約' },
    {
      id: 'reservation',
      path: '/api/reservations/:id',
      scope: 'local',
      title: '予約 (個別)',
    },
  ],
  panels: [
    {
      id: 'reservations',
      kind: 'declarative',
      title: '施設予約',
      icon: '📅',
      ui: reservationPanel,
    },
  ],
};
