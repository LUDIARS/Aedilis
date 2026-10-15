/** Trusted front ends that embed Ae and relay its API with a signed context. */
export type RelaySource = 'glab';

export interface MeetConfig {
  clientId: string; clientSecret: string; publicUrl: string;
  /**
   * Google redirect URIs per embedding front end. Ae's own page always returns to Ae's callback; a front end may
   * only use its own URIs, so GLab's callback can never receive a flow started from another embedding (neco
   * 2026-10-15「GLAB 経由で呼び出された Ae のコールバックは GLAB に、Ae 単品や別のサービスに組み込まれた場合は
   * 分けたい」). Each URI must also be registered on the Google OAuth client.
   */
  externalRedirectUris?: Partial<Record<RelaySource, readonly string[]>>;
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
    // AEDILIS_MEET_EXTERNAL_REDIRECT_URIS is the earlier name of GLab's list; read only when the new one is unset.
    externalRedirectUris: {
      glab: parseExternalRedirectUris(process.env.AEDILIS_MEET_GLAB_REDIRECT_URIS ?? process.env.AEDILIS_MEET_EXTERNAL_REDIRECT_URIS),
    },
  };
}
