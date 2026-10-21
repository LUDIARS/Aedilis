export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

/** One operator-managed OAuth web client, injected by Excubitor for all Ae integrations. */
export function googleOAuthClientConfig(env: NodeJS.ProcessEnv = process.env): GoogleOAuthClientConfig {
  return {
    clientId: env.AEDILIS_GOOGLE_CLIENT_ID?.trim() || '',
    clientSecret: env.AEDILIS_GOOGLE_CLIENT_SECRET?.trim() || '',
  };
}
