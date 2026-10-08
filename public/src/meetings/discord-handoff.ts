import { action, element, request, status, type Meeting } from './model.ts';

/** Capture before any asynchronous page work; capabilities must not survive in browser history. */
export function takeDiscordHandoff(): string | null {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('discord_handoff')) return null;
  const code = params.get('discord_handoff');
  history.replaceState(history.state, '', location.pathname + location.search);
  return code;
}
export function showDiscordRespondent(meeting: Meeting, reload: () => Promise<void>): void {
  const panel = element('discord-respondent');
  panel.hidden = !meeting.discordRespondent;
  if (!meeting.discordRespondent) return;
  element('discord-respondent-name').textContent = meeting.discordRespondent.displayName + '（Discord本人確認済み）';
  element('discord-disconnect').onclick = () => { void action(async () => {
    await request('/' + meeting.id + '/discord-session', 'DELETE', {});
    await reload(); status('この端末でのDiscord回答を終了しました。保存済みの回答は変更していません');
  }); };
}
export function offerDiscordHandoff(code: string, meetingId: string, reload: () => Promise<void>): void {
  const panel = element('discord-handoff');
  panel.hidden = false;
  element('response-panel').hidden = true;
  const button = element<HTMLButtonElement>('discord-handoff-accept');
  const dismiss = (): void => { panel.hidden = true; element('response-panel').hidden = false; };
  element('discord-handoff-cancel').onclick = dismiss;
  button.onclick = () => { void action(async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const result = await request<{ displayName: string }>('/' + meetingId + '/discord-handoff', 'POST', { code });
      dismiss(); await reload(); status(result.displayName + ' さんのDiscord IDに紐づけました。都合を入力して回答を保存してください');
    } catch (error) {
      // Consumption may have succeeded upstream: do not invite a replay of the same code.
      button.textContent = 'Discordで新しいリンクを取得してください';
      throw error;
    }
  }); };
}
