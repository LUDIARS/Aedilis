import settings from './settings.json' with { type: 'json' };

export interface MeetingConfig {
  publicUrl: string; cernereUrl: string; cernerePublicUrl: string; googleClientId: string;
  discordToken: string | null; notificationIntervalMs: number; notificationMaxAttempts: number;
}
export function meetingConfig(publicUrl: string, cernereUrl: string): MeetingConfig {
  const enabled = process.env.AEDILIS_DISCORD_ENABLED === undefined ? settings.discordEnabled : process.env.AEDILIS_DISCORD_ENABLED === 'true';
  if (process.env.AEDILIS_DISCORD_ENABLED !== undefined && !['true', 'false'].includes(process.env.AEDILIS_DISCORD_ENABLED)) throw new Error('AEDILIS_DISCORD_ENABLED must be true or false');
  const token = enabled ? process.env[settings.discordBotTokenSecret]?.trim() : null;
  if (enabled && !token) throw new Error('Discord enabled without AEDILIS_DISCORD_BOT_TOKEN');
  const cernerePublicUrl = process.env.AEDILIS_CERNERE_PUBLIC_URL?.trim() || settings.cernerePublicUrl;
  for (const value of [publicUrl, cernereUrl, cernerePublicUrl].filter(Boolean)) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Meeting integration URLs must be HTTP(S), without credentials');
  }
  return { publicUrl, cernereUrl, cernerePublicUrl, googleClientId: process.env.AEDILIS_GOOGLE_CLIENT_ID?.trim() || settings.googleClientId, discordToken: token || null,
    notificationIntervalMs: settings.notificationIntervalMs, notificationMaxAttempts: settings.notificationMaxAttempts };
}
