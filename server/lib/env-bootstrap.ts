/**
 * env-bootstrap — `.env` 直書きを使わない運用での env 注入。
 *
 * アプリ設定値 (CERNERE_BASE_URL / AEDILIS_ADMIN_IDS 等) は Infisical に置く。
 * Infisical に到達するための machine identity (INFISICAL_*) だけはどこかから
 * 渡す必要がある:
 *
 *   (A) Excubitor/Concordia 経由: parent が child env に INFISICAL_* を inject
 *   (B) `.env.secrets`: env-cli setup で書かれた machine identity を
 *                       `tsx --env-file-if-exists=.env.secrets` が読み込む
 *   (C) host shell env: 手動で INFISICAL_* を export してから起動
 *
 * Memoria / Cernere / Bibliotheca と同じパターン。
 */

const WANTED_KEYS: readonly string[] = [
  'CERNERE_BASE_URL',
  'AEDILIS_PUBLIC_URL',
  'AEDILIS_ADMIN_IDS',
];

export interface InfisicalCreds {
  siteUrl: string;
  projectId: string;
  environment: string;
  clientId: string;
  clientSecret: string;
}

interface InfisicalSecret { secretKey: string; secretValue: string }

function credsFromEnv(): InfisicalCreds | null {
  const siteUrl = process.env.INFISICAL_SITE_URL?.replace(/\/$/, '');
  const projectId = process.env.INFISICAL_PROJECT_ID;
  const environment = process.env.INFISICAL_ENVIRONMENT ?? 'dev';
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  if (!siteUrl || !projectId || !clientId || !clientSecret) return null;
  return { siteUrl, projectId, environment, clientId, clientSecret };
}

async function fetchSecrets(creds: InfisicalCreds): Promise<InfisicalSecret[]> {
  const siteUrl = creds.siteUrl.replace(/\/$/, '');
  const loginRes = await fetch(`${siteUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    }),
  });
  if (!loginRes.ok) {
    throw new Error(`Infisical login failed: ${loginRes.status}`);
  }
  const { accessToken } = (await loginRes.json()) as { accessToken: string };

  const params = new URLSearchParams({
    workspaceId: creds.projectId,
    environment: creds.environment,
    secretPath: '/',
  });
  const secretsRes = await fetch(
    `${siteUrl}/api/v3/secrets/raw?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!secretsRes.ok) {
    throw new Error(`Infisical secrets fetch failed: ${secretsRes.status}`);
  }
  const { secrets } = (await secretsRes.json()) as {
    secrets: InfisicalSecret[];
  };
  return secrets;
}

/** 既存の process.env 値は上書きしない (= Excubitor / host env 優先)。 */
function injectSecrets(secrets: InfisicalSecret[]): number {
  let injected = 0;
  for (const s of secrets) {
    if (!process.env[s.secretKey]) {
      process.env[s.secretKey] = s.secretValue;
      injected++;
    }
  }
  return injected;
}

export interface EnsureEnvResult {
  ok: boolean;
  injected: number;
  reason?: 'no_creds' | 'infisical_error';
  message?: string;
}

/**
 * 起動時に 1 回呼ぶ。 INFISICAL_* creds で Infisical から fetch + inject。
 * creds 不足 / 到達失敗どちらも throw せず result で返す。
 */
export async function ensureEnv(): Promise<EnsureEnvResult> {
  const creds = credsFromEnv();
  if (!creds) {
    return { ok: false, injected: 0, reason: 'no_creds' };
  }
  try {
    const secrets = await fetchSecrets(creds);
    const injected = injectSecrets(secrets);
    console.log(`[env-bootstrap] injected ${injected} secrets from Infisical`);
    return { ok: true, injected };
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[env-bootstrap] ${message} — Infisical をスキップして起動`);
    return { ok: false, injected: 0, reason: 'infisical_error', message };
  }
}

export function hasInfisicalCreds(): boolean {
  return credsFromEnv() !== null;
}

export function missingWantedKeys(): string[] {
  return WANTED_KEYS.filter((k) => !process.env[k]);
}
