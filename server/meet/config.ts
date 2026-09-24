export interface MeetConfig { clientId: string; clientSecret: string; publicUrl: string }
export const ORGANIZER_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/meetings.space.created', 'https://www.googleapis.com/auth/meetings.space.settings'];
export function meetConfig(publicUrl: string): MeetConfig {
  return { publicUrl, clientId: process.env.AEDILIS_GOOGLE_CLIENT_ID?.trim() || '', clientSecret: process.env.AEDILIS_GOOGLE_CLIENT_SECRET?.trim() || '' };
}
