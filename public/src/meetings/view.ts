import { element, escape, label, type Answer, type Meeting, type Slot } from './model.ts';

const symbols = { yes: '○', maybe: '△', no: '×' };
export function isBusy(meeting: Meeting, slot: Slot): boolean {
  return meeting.venues.find(v => v.name === slot.venue)?.busy.some(b => b.startAt < slot.endAt && b.endAt > slot.startAt) || false;
}
export function renderResponse(meeting: Meeting, response: Answer | undefined): void {
  element('response-title').textContent = response ? '自分の回答を編集' : 'あなたの都合を教えてください';
  element<HTMLInputElement>('response-name').value = response?.name || '';
  element<HTMLTextAreaElement>('response-comment').value = response?.comment || '';
  element<HTMLTextAreaElement>('response-topic').value = response?.topic || '';
  element('response-slots').innerHTML = meeting.slots.map(s => `<label class="answer-choice">${escape(label(s))} ${escape(s.venue || '会場未定')}<select data-slot="${escape(s.id)}" required><option value="">選んでください</option>${Object.entries(symbols).map(([key, symbol]) => `<option value="${key}" ${response?.answers[s.id] === key ? 'selected' : ''}>${symbol} ${key === 'yes' ? '参加できる' : key === 'maybe' ? '調整できれば参加' : '参加できない'}</option>`).join('')}</select></label>`).join('');
  const open = meeting.state === 'open';
  for (const field of element('response-form').querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) field.disabled = !open;
  element<HTMLButtonElement>('save-response').disabled = !open;
  element('delete-response').hidden = !response;
  if (!open) element('response-title').textContent = '回答受付は終了しました';
}
export function renderMeeting(meeting: Meeting, selectResponse: (answer: Answer) => void): void {
  element('meeting-title').textContent = meeting.title;
  element('meeting-description').textContent = meeting.description;
  element('meeting-organizer').textContent = `主催：${meeting.organizerName}`;
  element('meeting-state').textContent = { open: '日程調整中', finalized: '開催日時が決まりました', cancelled: 'この会議は中止されました' }[meeting.state];
  element<HTMLInputElement>('share-url').value = location.href;
  element('manage').hidden = !meeting.canManage || meeting.state === 'cancelled';
  element<HTMLSelectElement>('final-slot').innerHTML = meeting.slots.map(s => `<option value="${escape(s.id)}" ${isBusy(meeting, s) ? 'disabled' : ''}>${escape(label(s))} / ${escape(s.venue || '会場未定')}${isBusy(meeting, s) ? '（会場利用不可）' : ''}</option>`).join('');
  const final = meeting.slots.find(s => s.id === meeting.selectedSlot);
  if (final) element<HTMLSelectElement>('final-slot').value = final.id;
  element('final-choice').textContent = final ? `開催：${label(final)} / ${final.venue || '会場未定'}` : '○ 参加できる　△ 調整できれば参加　× 参加できない　— 未回答';
  const columns = meeting.slots.map(s => `<th class="${s.id === meeting.selectedSlot ? 'choice-final' : ''}">${escape(label(s))}<br>${escape(s.venue || '会場未定')}<br><small class="${isBusy(meeting, s) ? 'busy' : 'available'}">${isBusy(meeting, s) ? '会場利用不可' : '登録済み予定との重複なし'}</small></th>`).join('');
  const rows = meeting.responses.map(r => `<tr><th>${escape(r.name)}${r.canEdit ? '（自分）' : ''}</th>${meeting.slots.map(s => { const value = r.answers[s.id]; return `<td>${value ? symbols[value] : '—'}</td>`; }).join('')}</tr>`).join('');
  const counts = meeting.slots.map(s => `<td>${meeting.responses.filter(r => r.answers[s.id] === 'yes').length}人</td>`).join('');
  element('answer-table').innerHTML = `<table><thead><tr><th>参加者</th>${columns}</tr></thead><tbody>${rows}<tr><th>○ の人数</th>${counts}</tr></tbody></table>`;
  const comments = element('comments'); comments.replaceChildren();
  for (const r of meeting.responses) {
    const node = document.createElement('div'); node.className = 'comment';
    node.innerHTML = `<strong>${escape(r.name)}</strong>${r.comment ? `<p>${escape(r.comment)}</p>` : ''}${r.topic ? `<p><b>話したいこと</b><br>${escape(r.topic)}</p>` : ''}`;
    if (r.canEdit) { const edit = document.createElement('button'); edit.textContent = '自分の回答'; edit.onclick = () => { selectResponse(r); element('response-panel').scrollIntoView({ behavior: 'smooth' }); }; node.append(edit); }
    comments.append(node);
  }
  if (!meeting.responses.length) comments.textContent = 'まだ回答がありません。共有URLを参加者に送ってください。';
}
