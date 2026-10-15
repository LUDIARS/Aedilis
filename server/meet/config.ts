export interface MeetConfig {
  clientId: string; clientSecret: string; publicUrl: string;
  /** Google redirect URIs owned by trusted front ends (GLab). Each must also be registered on the Google OAuth client. */
  externalRedirectUris?: readonly string[];
}
export const ORGANIZER_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/meetings.space.created', 'https://www.googleapis.com/auth/meetings.space.settings'];

/** Only exact HTTPS (or numeric loopback HTTP) URIs without query/fragment are accepted; anything else is dropped. */
export function parseExternalRedirectUris(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean).flatMap((item) => {
    try {
      const url = new URL(item);
      const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash) return [];
      return [url.href];
    }
    catch { return []; }
  }))];
}

export function meetConfig(publicUrl: string): MeetConfig {
  return {
    publicUrl,
    clientId: process.env.AEDILIS_GOOGLE_CLIENT_ID?.trim() || '',
    clientSecret: process.env.AEDILIS_GOOGLE_CLIENT_SECRET?.trim() || '',
    externalRedirectUris: parseExternalRedirectUris(process.env.AEDILIS_MEET_EXTERNAL_REDIRECT_URIS),
  };
}
