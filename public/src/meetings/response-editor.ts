import { element, escape, dateMarkup, type Answer, type Meeting } from './model.ts';

const choices = { yes: ['○', '参加できる'], maybe: ['△', '調整できれば参加'], no: ['×', '参加できない'] } as const;
export function renderResponse(meeting: Meeting, response: Answer | undefined): void {
  const open = meeting.state === 'open';
  element('response-title').textContent = !open ? '回答受付は終了しました' : response ? '自分の回答を編集' : 'あなたの都合を教えてください';
  element<HTMLInputElement>('response-name').value = response?.name || '';
  element<HTMLTextAreaElement>('response-comment').value = response?.comment || '';
  element<HTMLTextAreaElement>('response-topic').value = response?.topic || '';
  const base = element<HTMLInputElement>('response-default-online'); base.checked = response?.defaultOnline ?? false;
  element('response-slots').innerHTML = meeting.slots.map(slot => {
    const overridden = Object.prototype.hasOwnProperty.call(response?.online ?? {}, slot.id);
    const online = response?.online?.[slot.id] ?? base.checked;
    return `<fieldset class="answer-choice" data-slot="${escape(slot.id)}" ${open ? '' : 'disabled'}><legend>${dateMarkup(slot)} ${escape(slot.venue || '会場未定')}</legend>
      <div class="answer-buttons" role="group" aria-label="参加可否">${Object.entries(choices).map(([value, [symbol, text]]) => `<button type="button" data-answer="${value}" aria-label="${symbol} ${text}" aria-pressed="${response?.answers[slot.id] === value}">${symbol}<span>${text}</span></button>`).join('')}</div>
      <label class="inline-check"><input type="checkbox" class="answer-online" ${online ? 'checked' : ''} data-override="${overridden}">ONLINE <span>オンラインなら参加可能</span></label>
      <button type="button" class="online-reset" ${overridden ? '' : 'hidden'}>基本ONLINEに合わせる</button></fieldset>`;
  }).join('');
  const rows = [...element('response-slots').querySelectorAll<HTMLFieldSetElement>('fieldset')];
  for (const row of rows) {
    for (const button of row.querySelectorAll<HTMLButtonElement>('[data-answer]')) button.onclick = () => {
      for (const other of row.querySelectorAll('[data-answer]')) other.setAttribute('aria-pressed', String(other === button));
    };
    const online = row.querySelector<HTMLInputElement>('.answer-online');
    const reset = row.querySelector<HTMLButtonElement>('.online-reset');
    if (online && reset) {
      online.onchange = () => { online.dataset.override = 'true'; reset.hidden = false; };
      reset.onclick = () => { online.dataset.override = 'false'; online.checked = base.checked; reset.hidden = true; };
    }
  }
  base.onchange = () => {
    for (const row of rows) {
      const online = row.querySelector<HTMLInputElement>('.answer-online');
      if (online && online.dataset.override !== 'true') online.checked = base.checked;
    }
  };
  for (const field of element('response-form').querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) field.disabled = !open;
  element<HTMLButtonElement>('save-response').disabled = !open;
  element('delete-response').hidden = !response;
}

export function readResponseChoices(): { answers: Answer['answers']; online: Record<string, boolean>; defaultOnline: boolean } {
  const answers: Answer['answers'] = {}, online: Record<string, boolean> = {};
  for (const row of element('response-slots').querySelectorAll<HTMLElement>('[data-slot]')) {
    const id = row.dataset.slot;
    const selected = row.querySelector<HTMLElement>('[data-answer][aria-pressed="true"]')?.dataset.answer;
    if (!id || (selected !== 'yes' && selected !== 'maybe' && selected !== 'no')) throw new Error('すべての日程で ○・△・× を選んでください');
    answers[id] = selected;
    const checkbox = row.querySelector<HTMLInputElement>('.answer-online');
    if (checkbox?.dataset.override === 'true') online[id] = checkbox.checked;
  }
  return { answers, online, defaultOnline: element<HTMLInputElement>('response-default-online').checked };
}
