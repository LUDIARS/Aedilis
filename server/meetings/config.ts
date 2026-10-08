import settings from './settings.json' with { type: 'json' };

export interface MeetingConfig {
  publicUrl: string; cernereUrl: string; cernerePublicUrl: string; googleClientId: string;
  discordToken: string | null; notificationIntervalMs: number; notificationMaxAttempts: number;
  discordHandoffUrl?: string | null; discordHandoffGuildId?: string | null;
}
export function meetingConfig(publicUrl: string, cernereUrl: string): MeetingConfig {
  const handoffEnabled = process.env.AEDILIS_DISCORD_HANDOFF_ENABLED;
  if (handoffEnabled !== undefined && !['true', 'false'].includes(handoffEnabled)) throw new Error('AEDILIS_DISCORD_HANDOFF_ENABLED must be true or false');
  const discordHandoffUrl = handoffEnabled === 'true' ? process.env.CONCORDIA_URL?.trim() : null;
  const discordHandoffGuildId = handoffEnabled === 'true' ? process.env.AEDILIS_DISCORD_GUILD_ID?.trim() : null;
  if (handoffEnabled === 'true') {
    if (!discordHandoffUrl || !discordHandoffGuildId || !/^\d{17,20}$/.test(discordHandoffGuildId)) throw new Error('Discord handoff requires CONCORDIA_URL and AEDILIS_DISCORD_GUILD_ID');
    const issuer = new URL(discordHandoffUrl);
    if (issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== '/'
      || (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)))) {
      throw new Error('Discord handoff issuer must be an HTTPS or loopback HTTP origin');
    }
  }
  const enabled = process.env.AEDILIS_DISCORD_ENABLED === undefined ? settings.discordEnabled : process.env.AEDILIS_DISCORD_ENABLED === 'true';
  if (process.env.AEDILIS_DISCORD_ENABLED !== undefined && !['true', 'false'].includes(process.env.AEDILIS_DISCORD_ENABLED)) throw new Error('AEDILIS_DISCORD_ENABLED must be true or false');
  const token = enabled ? process.env[settings.discordBotTokenSecret]?.trim() : null;
  if (enabled && !token) throw new Error('Discord enabled without AEDILIS_DISCORD_BOT_TOKEN');
  const cernerePublicUrl = process.env.AEDILIS_CERNERE_PUBLIC_URL?.trim() || settings.cernerePublicUrl;
  for (const value of [publicUrl, cernereUrl, cernerePublicUrl].filter(Boolean)) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Meeting integration URLs must be HTTP(S), without credentials');
  }
  return { publicUrl, cernereUrl, cernerePublicUrl, discordHandoffUrl, discordHandoffGuildId, googleClientId: process.env.AEDILIS_GOOGLE_CLIENT_ID?.trim() || settings.googleClientId, discordToken: token || null,
    notificationIntervalMs: settings.notificationIntervalMs, notificationMaxAttempts: settings.notificationMaxAttempts };
}
