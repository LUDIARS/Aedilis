/** Validate the environment injected by Excubitor before importing the app. */
const REQUIRED_KEYS: readonly string[] = [
  'CERNERE_BASE_URL',
  'AEDILIS_PUBLIC_URL',
  // Excubitor obtains these short-lived credentials from Cernere at launch.
  'CERNERE_PROJECT_CLIENT_ID',
  'CERNERE_PROJECT_CLIENT_SECRET',
];

export function assertRequiredEnv(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    // Only allow-listed names belong in diagnostics; never include env values.
    throw new Error(`[bootstrap] Missing required environment: ${missing.join(', ')}`);
  }
}
