import { action, element, escape, request, status, type Answer, type Config, type Meeting } from './model.ts';
import { addSlot, addVenue, fillEditor, readEditor } from './editor.ts';
import { setupGoogle } from './google.ts';
import { refreshAccount, setupAccount } from './account.ts';
import { renderMeeting, renderResponse } from './view.ts';

let meeting: Meeting | null = null;
let response: Answer | undefined;
let editing = false;
function page(id: 'home' | 'editor' | 'meeting'): void { for (const name of ['home', 'editor', 'meeting']) element(name).hidden = name !== id; }
function selectResponse(answer: Answer | undefined): void { response = answer; if (meeting) renderResponse(meeting, answer); }
async function reload(): Promise<void> {
  const id = new URLSearchParams(location.search).get('meeting');
  if (!id) {
    meeting = null; page('home');
    const { items } = await request<{ items: Array<{ id: string; title: string; state: string }> }>('/mine');
    element('mine').innerHTML = items.map(i => `<a href="/meetings?meeting=${encodeURIComponent(i.id)}">${escape(i.title)} · ${{ open: '調整中', finalized: '確定', cancelled: '中止' }[i.state] || ''}</a>`).join('') || '<p>会議を作成・回答するとここに表示されます。</p>';
    return;
  }
  meeting = await request<Meeting>(`/${encodeURIComponent(id)}`);
  page('meeting'); renderMeeting(meeting, selectResponse);
  selectResponse(meeting.responses.find(r => r.id === response?.id && r.canEdit) || meeting.responses.find(r => r.canEdit));
}
async function saveAnswer(): Promise<void> {
  if (!meeting) return;
  const answers = Object.fromEntries([...element('response-slots').querySelectorAll<HTMLSelectElement>('select')].map(s => [s.dataset.slot, s.value]));
  const body = { name: element<HTMLInputElement>('response-name').value, comment: element<HTMLTextAreaElement>('response-comment').value, topic: element<HTMLTextAreaElement>('response-topic').value,
    answers, revision: response?.revision, meetingRevision: meeting.revision };
  await request(`/${meeting.id}/responses${response ? `/${response.id}` : ''}`, response ? 'PATCH' : 'POST', body);
  await reload(); status('回答を保存しました。同じ端末から編集できます');
}
function editMeeting(isNew: boolean): void {
  editing = !isNew;
  fillEditor(isNew ? undefined : meeting || undefined); page('editor');
  element('editor-title').textContent = isNew ? '日程調整をつくる' : '会議を編集';
  element('save-meeting').textContent = isNew ? '作成して共有する' : '変更を保存';
}
async function main(): Promise<void> {
  const config = await request<Config>('/config');
  await refreshAccount(config); setupAccount(config, reload); setupGoogle(config);
  element('new-meeting').onclick = () => editMeeting(true);
  element('edit-meeting').onclick = () => editMeeting(false);
  element('add-slot').onclick = () => addSlot(); element('add-venue').onclick = () => addVenue();
  element('cancel-editor').onclick = () => { void action(reload); };
  element('meeting-form').onsubmit = event => {
    event.preventDefault();
    const button = element<HTMLButtonElement>('save-meeting'); if (button.disabled) return; button.disabled = true;
    void action(async () => {
      try {
        const input = readEditor();
        if (editing && meeting) await request(`/${meeting.id}`, 'PATCH', { ...input, revision: meeting.revision });
        else {
          const result = await request<{ id: string }>('', 'POST', input);
          history.pushState(null, '', `/meetings?meeting=${encodeURIComponent(result.id)}`);
        }
        await reload(); status('保存しました。共有URLを参加者に送ってください');
      } finally { button.disabled = false; }
    });
  };
  element('response-form').onsubmit = event => {
    event.preventDefault(); const button = element<HTMLButtonElement>('save-response'); if (button.disabled) return; button.disabled = true;
    void action(async () => { try { await saveAnswer(); } finally { button.disabled = meeting?.state !== 'open'; } });
  };
  element('delete-response').onclick = () => { void action(async () => {
    if (!meeting || !response || !confirm('自分の回答を削除しますか？')) return;
    await request(`/${meeting.id}/responses/${response.id}`, 'DELETE', { revision: response.revision }); response = undefined; await reload(); status('回答を削除しました');
  }); };
  element('finalize').onclick = () => { void action(async () => {
    if (!meeting || !confirm('この日時で開催を確定しますか？会場の予約確保は別途必要です。')) return;
    await request(`/${meeting.id}/finalize`, 'POST', { slotId: element<HTMLSelectElement>('final-slot').value, revision: meeting.revision }); await reload(); status('開催日時を確定しました');
  }); };
  element('cancel-meeting').onclick = () => { void action(async () => {
    if (!meeting || !confirm('この会議を中止しますか？')) return;
    await request(`/${meeting.id}`, 'DELETE', { revision: meeting.revision }); await reload(); status('会議を中止しました');
  }); };
  element('copy-link').onclick = () => { void action(async () => { await navigator.clipboard.writeText(element<HTMLInputElement>('share-url').value); status('共有URLをコピーしました'); }); };
  window.addEventListener('popstate', () => { void action(reload); });
  await reload();
}
void action(main);
