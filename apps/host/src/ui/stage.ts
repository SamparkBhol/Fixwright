// The stage: a wall that follows house time, the device standing on a shelf, the house plan under it,
// the captions and the composer. The view slot is one element that never moves in the DOM, because
// moving an iframe reloads it, so device changes are CSS plus a hostContext update.

import { normalize, stripInvocation, type ConversationState } from '@fixwright/router';
import type { HostApp } from '../app.ts';
import { formatClock } from '../clock.ts';
import { DEVICES, DEVICE_ORDER, HOUSE_TIME_ZONE, type DeviceClass } from '../devices.ts';
import type { AppState, Approval, PushNote, ReplyCard, TranscriptEntry } from '../state.ts';
import { h, icon, silhouette } from './dom.ts';
import { mountHouse } from './house.ts';
import { clockWords } from '../house.ts';

const BEZEL: Record<Exclude<DeviceClass, 'voice'>, number> = { large: 22, small: 20, phone: 12 };
// How much larger than the large display's scale a smaller device may be drawn. At one physical scale
// a small display's text is tiny on a laptop; these keep it visibly smaller than the large one and
// still readable. The phone hits the stage height before its boost.
const SCALE_BOOST: Record<Exclude<DeviceClass, 'voice'>, number> = { large: 1, small: 1.2, phone: 1.35 };
const SPEAKER_SIZE = 360;
/** Room the speaker leaves above itself for a push card, since it has no screen to show one. */
const VOICE_TOAST_ROOM = 112;
/** Where the shelf line sits, from the bottom of the canvas. */
const SHELF = 14;
const STAND = 56;
const RING_LABEL = { idle: 'Ready', listening: 'Listening', thinking: 'Asking Fixwright', speaking: 'Speaking' } as const;

const LONG_PLACEHOLDER = 'Type what you would say, for example “Give my house a checkup”';
const SHORT_PLACEHOLDER = 'Type what you would say';
const TRY_LINE = 'Try “Why is the hallway lamp not responding?”';

/** A suggestion in another language says which one, so it never reads as stray text. */
const CHIP_LANG: Record<string, { lang: string; name: string }> = { 'haan, jal raha hai': { lang: 'hi', name: 'Hindi' } };

// A request Alexa would handle itself (switching a strip) names the add-on, the way a real Echo needs it.
const STARTERS = [
  'Why is the hallway lamp not responding?',
  'Why did every plug turn on at 3 a.m.?',
  'Give my house a checkup',
  'Ask Fixwright to turn off the living room power strip',
  'Never turn off the aquarium filter',
];

/** The same words, ignoring case, punctuation and "Alexa, ask Fixwright to". */
const sameWords = (text: string): string => normalize(stripInvocation(text));

/** What the person already said, so a suggestion they used is not offered again (OPEN L3). */
export function askedOf(transcript: readonly Pick<TranscriptEntry, 'role' | 'text'>[]): Set<string> {
  return new Set(transcript.filter((t) => t.role === 'user').map((t) => sameWords(t.text)));
}

/** The push to caption: one that landed after the last turn and is still on the device, else null. */
export function pushCaption(s: Pick<AppState, 'toast' | 'toastAfter' | 'transcript' | 'interim'>): string | null {
  if (!s.toast || s.interim) return null;
  const last = s.transcript.at(-1);
  return !last || last.id <= s.toastAfter ? s.toast.message : null;
}

export function suggestionsFor(conv: ConversationState, approval: Approval | null = null, asked: ReadonlySet<string> = new Set()): string[] {
  // While the sheet is open, the chips answer it by voice, in the words a person would say.
  if (approval) return [approval.confirm, 'Not now'];
  if (conv.pendingQuestion) return ['Yes, it blinked', "No, it didn't", 'haan, jal raha hai'];
  // "What will it change?" reads the dry run again: the router answers a question while a plan waits.
  if (conv.pendingPlan) return ['Yes, do it', 'No, leave it', 'What will it change?'];
  if (conv.pendingOffer) return ['Yes', 'No thanks'];
  const fresh = STARTERS.filter((s) => !asked.has(sameWords(s)));
  const starters = fresh.length > 0 ? fresh : STARTERS;
  if (conv.last.repair_id) return ['Did the fix hold?', 'Undo that', ...starters.filter((s) => s !== STARTERS[0]).slice(0, 3)];
  return starters;
}

/** "House time 3:00 PM, simulated": the clock the wall follows, labeled the way the server labels it. */
export function houseTimeLabel(ms: number, timeZone: string, simulated: boolean | null): string {
  const time = clockWords(ms, timeZone);
  return simulated === false ? `House time ${time}` : `House time ${time}, simulated`;
}

/** A push's title and message as one card shows them: the title is not said again at the message's end. */
export function pushBody(p: Pick<PushNote, 'title' | 'message'>): string {
  const title = p.title.trim().replace(/[.!]+$/, '');
  const message = p.message.trim();
  if (!title || !message.endsWith(`${title}.`) || message.length === title.length + 1) return message;
  return message.slice(0, -(title.length + 1)).trim();
}

const REPLY_TAG: Record<string, { icon: 'shield' | 'check'; text: string }> = {
  refused: { icon: 'shield', text: 'Kept on' },
  protect_device: { icon: 'shield', text: 'Protected' },
  ok: { icon: 'check', text: 'Done' },
};

/** The tag on a reply card: what the turn did, in one or two words. */
export function replyTag(card: Pick<ReplyCard, 'tool' | 'status'>): { icon: 'shield' | 'check'; text: string } {
  if (card.status === 'refused') return REPLY_TAG['refused'] as { icon: 'shield'; text: string };
  if (card.tool === 'protect_device') return REPLY_TAG['protect_device'] as { icon: 'shield'; text: string };
  return REPLY_TAG['ok'] as { icon: 'check'; text: string };
}

export function mountStage(root: HTMLElement, app: HostApp): void {
  const { store } = app;

  const switcher = h('div', { class: 'switcher', role: 'tablist', 'aria-label': 'Simulated device' });
  const switchButtons = new Map<DeviceClass, HTMLButtonElement>();
  for (const id of DEVICE_ORDER) {
    const spec = DEVICES[id];
    const name = `${spec.label}, ${spec.detail}`;
    const b = h('button', { class: 'switch', role: 'tab', type: 'button', 'data-device': id, 'aria-label': name, title: name, onclick: () => void app.setDevice(id) }, silhouette(id));
    switchButtons.set(id, b);
    switcher.append(b);
  }
  const deviceName = h('span', { class: 'device-name' });
  const ringLabel = h('span', { class: 'ring-label' });
  const houseTime = h('span', { class: 'house-time' });
  const top = h('div', { class: 'stage-top' }, switcher, h('p', { class: 'device-line' }, deviceName, ringLabel), houseTime);

  const idleTime = h('div', { class: 'idle-time' });
  const idleDate = h('div', { class: 'idle-date' });
  const idle = h(
    'div',
    { class: 'idle' },
    h('div', { class: 'idle-clock' }, idleTime, idleDate),
    h('div', { class: 'idle-hint' }, h('span', { class: 'idle-label', text: 'Fixwright add-on is ready' }), h('span', { class: 'idle-try', text: TRY_LINE })),
  );
  const replyTagIcon = h('span', { class: 'reply-tag-icon' });
  const replyTagText = h('span');
  const replyText = h('p', { class: 'reply-text' });
  const replyDetail = h('p', { class: 'reply-detail' });
  const reply = h(
    'section',
    { class: 'reply-card', 'aria-label': 'Fixwright reply', hidden: true },
    h('div', { class: 'reply-head' }, h('span', { class: 'reply-app', text: 'Fixwright' }), h('span', { class: 'reply-tag' }, replyTagIcon, replyTagText)),
    replyText,
    replyDetail,
  );
  const phoneHint = h('div', { class: 'phone-hint' }, h('span', { class: 'idle-label', text: 'Fixwright add-on is ready' }), h('span', { class: 'idle-try', text: TRY_LINE }));
  const activity = h('div', { class: 'activity', role: 'status', 'aria-live': 'polite' });
  const viewSlot = h('div', { class: 'view-slot', id: 'view-slot' });
  const phoneTime = h('span');
  const phoneChat = h('div', { class: 'phone-chat' });
  const phoneTop = h(
    'div',
    { class: 'phone-top' },
    h('div', { class: 'phone-status' }, phoneTime, h('span', { class: 'phone-icons' }, h('i'), h('i'), h('i'))),
    h('div', { class: 'phone-app' }, h('span', { class: 'phone-app-name', text: 'Assistant' }), h('span', { class: 'phone-app-sub', text: 'Fixwright add-on' })),
  );
  const approvalTitle = h('h2', { class: 'approval-title', id: 'approval-title' });
  const approvalYes = h('button', { type: 'button', class: 'btn primary', 'data-approve': 'yes', onclick: () => app.answerApproval(true), text: 'Yes' });
  const approvalLines = h('ul', { class: 'approval-lines' });
  const approvalNote = h('p', { class: 'approval-source' });
  const approvalFooter = h('p', { class: 'approval-note' });
  const approval = h(
    'div',
    { class: 'approval', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'approval-title', hidden: true },
    h(
      'div',
      { class: 'approval-card' },
      h('div', { class: 'approval-eyebrow' }, icon('shield', 16), h('span', { text: 'Your OK is needed' })),
      approvalTitle,
      approvalLines,
      approvalNote,
      approvalFooter,
      h(
        'div',
        { class: 'approval-actions' },
        h('button', { type: 'button', class: 'btn ghost', 'data-approve': 'no', onclick: () => app.answerApproval(false), text: 'Not now' }),
        approvalYes,
      ),
    ),
  );
  // A push notification (golden path step 4). It never sits on a view: on a display it takes the caption
  // band under the device, on the phone the top of the screen over the chat, and with no screen it sits
  // above the speaker. Tapping it opens the repair it is about.
  const toastCard = (cls: string, source: string): { el: HTMLElement; fill: (p: PushNote | null) => void } => {
    const time = h('time');
    const title = h('strong', { class: 'toast-title' });
    const message = h('span', { class: 'toast-message' });
    let shown: PushNote | null = null;
    const open = h(
      'button',
      { type: 'button', class: 'toast-open', onclick: () => shown && void app.openPush(shown) },
      h('span', { class: 'toast-app' }, h('span', { class: 'toast-icon' }, icon('bell', 14)), h('span', { text: source }), time),
      title,
      message,
    );
    const el = h(
      'div',
      { class: cls, role: 'status', 'aria-live': 'polite', hidden: true },
      open,
      h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss notification', onclick: () => app.dismissToast() }, icon('x', 14)),
    );
    const fill = (p: PushNote | null): void => {
      shown = p;
      el.hidden = !p;
      if (!p) return;
      const at = Date.parse(p.at);
      time.textContent = Number.isFinite(at) ? formatClock(at, HOUSE_TIME_ZONE).time : '';
      title.textContent = p.title;
      message.textContent = pushBody(p);
      open.setAttribute('aria-label', `${p.title}. ${pushBody(p)} Open the repair.`);
    };
    return { el, fill };
  };
  const phoneToast = toastCard('push-toast phone-toast', 'Fixwright');
  const captionToast = toastCard('push-toast caption-toast', 'Fixwright push');
  const voiceToast = toastCard('push-toast voice-toast', 'Fixwright, pushed to your phone');
  const screen = h('div', { class: 'screen' }, idle, phoneTop, phoneChat, viewSlot, reply, activity, phoneToast.el, approval);
  const display = h('div', { class: 'device-body' }, h('div', { class: 'bezel' }, h('i', { class: 'camera' }), screen), h('div', { class: 'stand' }));

  const ring = h('div', { class: 'ring' });
  const speaker = h('div', { class: 'speaker' }, h('div', { class: 'speaker-body' }, ring, h('div', { class: 'speaker-top' }, h('div', { class: 'speaker-mesh' }))));

  const device = h('div', { class: 'device', id: 'device' }, display, speaker);
  const scaler = h('div', { class: 'scaler' }, device);
  const canvas = h('div', { class: 'stage-canvas' }, scaler, h('div', { class: 'shelf', 'aria-hidden': 'true' }), voiceToast.el);

  const houseEl = h('section', { class: 'house', 'aria-label': 'The house' });

  const capUser = h('p', { class: 'cap cap-user' });
  const capReply = h('p', { class: 'cap cap-reply' });
  const captions = h('div', { class: 'captions', 'aria-live': 'polite' }, capUser, capReply, captionToast.el);

  const input = h('input', {
    class: 'composer-input',
    id: 'utterance',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Say something to the assistant',
    placeholder: LONG_PLACEHOLDER,
  });
  // A phone width page would cut the long placeholder mid word.
  const narrow = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 700px)') : null;
  const fitPlaceholder = (): void => {
    input.placeholder = narrow?.matches ? SHORT_PLACEHOLDER : LONG_PLACEHOLDER;
  };
  fitPlaceholder();
  narrow?.addEventListener('change', fitPlaceholder);
  const mic = h('button', { type: 'button', class: 'mic', 'aria-label': 'Speak', onclick: () => (store.get().listening ? app.listener.stop() : app.listener.start()) }, icon('mic', 20));
  const send = h('button', { type: 'submit', class: 'send', text: 'Say' });
  const form = h('form', { class: 'composer', id: 'composer' }, mic, input, send);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    void app.say(text, 'typed');
  });
  const chips = h('div', { class: 'chips', 'aria-label': 'Suggestions' });
  const dock = h('div', { class: 'dock' }, form, chips);

  root.append(top, canvas, h('div', { class: 'floor' }, houseEl, captions, dock));
  let replayClock: number | null = null;
  const paintHouseTime = (): void => {
    const s = store.get();
    const zone = s.house?.clock?.tz ?? HOUSE_TIME_ZONE;
    houseTime.textContent = !s.clockKnown ? '' : replayClock !== null ? `Replaying ${clockWords(replayClock, zone)}` : houseTimeLabel(app.clock.nowMs(), zone, s.house?.clock ? s.house.clock.simulated : null);
    houseTime.title = s.house?.clock?.note ?? '';
  };
  mountHouse(houseEl, root, app, {
    onReplayClock(ms) {
      if (ms === replayClock) return;
      replayClock = ms;
      paintHouseTime();
    },
  });
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (e.key === 'Escape' && store.get().approval) {
      e.preventDefault();
      app.answerApproval(false);
      return;
    }
    if (e.key === '/' && target?.tagName !== 'INPUT' && target?.tagName !== 'TEXTAREA') {
      e.preventDefault();
      input.focus();
    }
  });
  app.mountViewSlot(viewSlot);

  const fit = (): void => {
    const s = store.get();
    const box = canvas.getBoundingClientRect();
    if (s.device === 'voice') {
      const room = s.toast ? VOICE_TOAST_ROOM : 0;
      scaler.style.setProperty('--scale', String(Math.min(1, Math.max(0.4, (box.height - SHELF - 24 - room) / SPEAKER_SIZE))));
      scaler.style.width = `${SPEAKER_SIZE}px`;
      scaler.style.height = `${SPEAKER_SIZE}px`;
      return;
    }
    const natural = (d: Exclude<DeviceClass, 'voice'>): { w: number; h: number } => {
      const scr = DEVICES[d].screen ?? { width: 1, height: 1 };
      return { w: scr.width + BEZEL[d] * 2, h: scr.height + BEZEL[d] * 2 + (d === 'phone' ? 0 : STAND) };
    };
    const fits = (n: { w: number; h: number }): number => Math.min((box.width - 48) / n.w, (box.height - SHELF - 16) / n.h, 1);
    // The canvas only changes with the window or the device (captions and chips have fixed heights), so
    // the scale holds still from one turn to the next.
    const scr = DEVICES[s.device].screen ?? { width: 1, height: 1 };
    const { w: natW, h: natH } = natural(s.device);
    const scale = Math.min(fits({ w: natW, h: natH }), fits(natural('large')) * SCALE_BOOST[s.device]);
    scaler.style.setProperty('--scale', String(Math.max(0.2, Math.round(scale * 1000) / 1000)));
    scaler.style.width = `${natW}px`;
    scaler.style.height = `${natH}px`;
    device.style.setProperty('--screen-w', `${scr.width}px`);
    device.style.setProperty('--screen-h', `${scr.height}px`);
    device.style.setProperty('--bezel', `${BEZEL[s.device]}px`);
  };
  new ResizeObserver(fit).observe(canvas);

  const lastOf = (t: readonly TranscriptEntry[], role: TranscriptEntry['role']): TranscriptEntry | undefined => {
    for (let i = t.length - 1; i >= 0; i--) if (t[i]?.role === role) return t[i];
    return undefined;
  };

  let lastChipsKey = '';
  let asked: Set<string> = new Set();
  function render(s: AppState, prev: AppState | null): void {
    if (!prev || s.device !== prev.device) {
      device.dataset['device'] = s.device;
      root.dataset['device'] = s.device;
      for (const [id, b] of switchButtons) b.setAttribute('aria-selected', String(id === s.device));
      deviceName.textContent = `${DEVICES[s.device].label}, ${DEVICES[s.device].detail}`;
      fit();
    }
    const zone = s.house?.clock?.tz ?? HOUSE_TIME_ZONE;
    // Blank until the house clock is read: the browser's own time would show for a moment, then jump.
    const { time, date } = s.clockKnown ? formatClock(app.clock.nowMs(), zone) : { time: '', date: '' };
    idleTime.textContent = time;
    idleDate.textContent = date;
    phoneTime.textContent = time.replace(/\s?[AP]M$/, '');
    paintHouseTime();
    const card = s.viewTool ? null : s.replyCard;
    screen.dataset['hasView'] = String(!!s.viewTool);
    screen.dataset['hasCard'] = String(!!card);
    if (!prev || card !== (prev.viewTool ? null : prev.replyCard)) {
      reply.hidden = !card;
      if (card) {
        const tag = replyTag(card);
        replyTagIcon.replaceChildren(icon(tag.icon, 18));
        replyTagText.textContent = tag.text;
        reply.dataset['tone'] = tag.icon === 'shield' ? 'protect' : 'done';
        replyText.textContent = card.text;
        replyDetail.textContent = card.switched ? `${card.switched.name} is ${card.switched.state} now.` : '';
        replyDetail.hidden = !card.switched;
      }
    }
    activity.textContent = s.busy ?? '';
    activity.dataset['on'] = String(!!s.busy);

    const ringState = s.listening ? 'listening' : s.busy ? 'thinking' : s.speaking ? 'speaking' : 'idle';
    ring.dataset['state'] = ringState;
    speaker.dataset['state'] = ringState;
    ringLabel.textContent = s.device === 'voice' ? RING_LABEL[ringState] : '';
    ringLabel.dataset['state'] = ringState;

    if (
      !prev ||
      s.transcript !== prev.transcript ||
      s.interim !== prev.interim ||
      s.speaking !== prev.speaking ||
      s.viewTool !== prev.viewTool ||
      s.busy !== prev.busy ||
      s.approval !== prev.approval ||
      s.toast !== prev.toast ||
      s.device !== prev.device
    ) {
      const u = lastOf(s.transcript, 'user');
      const a = lastOf(s.transcript, 'assistant');
      const assistantIsLatest = !!a && (!u || a.id > u.id);
      // A push that landed after the last turn is the newest thing on the device, so the captions show it
      // instead of pairing the previous turn with it. On a display the push card fills the caption band.
      const push = pushCaption(s);
      const pushCard = !!push && !s.approval && (s.device === 'large' || s.device === 'small');
      capUser.textContent = push ? '' : s.interim || (u ? u.text : '');
      capUser.dataset['via'] = !s.interim && (u?.via === 'view' || u?.via === 'tap') ? u.via : 'person';
      capUser.hidden = !capUser.textContent;
      // While the sheet is open, its question is what the assistant is asking.
      capReply.textContent = s.approval ? s.approval.title : push ?? (assistantIsLatest && a ? a.text : s.busy ? '…' : '');
      capReply.dataset['kind'] = push && !s.approval ? 'push' : 'reply';
      capReply.hidden = !capReply.textContent || pushCard;
      captionToast.fill(pushCard ? s.toast : null);
      capReply.dataset['speaking'] = String(!!s.speaking);
      phoneChat.replaceChildren(...(s.transcript.length === 0 ? [phoneHint] : s.transcript.slice(-4).map((e) => h('div', { class: `bubble ${e.role}` }, h('span', { text: e.text })))));
    }

    if (!prev || s.approval !== prev.approval) {
      approval.hidden = !s.approval;
      approvalTitle.textContent = s.approval?.title ?? '';
      approvalLines.replaceChildren(...(s.approval?.lines ?? []).map((l) => h('li', { text: l })));
      approvalLines.hidden = !s.approval?.lines.length;
      approvalNote.textContent = s.approval?.note ?? '';
      approvalNote.hidden = !s.approval?.note;
      approvalFooter.textContent = s.approval?.footer ?? '';
      approvalYes.textContent = s.approval?.confirm ?? 'Yes';
      if (s.approval) approvalYes.focus();
    }

    if (!prev || s.toast !== prev.toast || s.device !== prev.device) {
      phoneToast.fill(s.device === 'phone' ? s.toast : null);
      voiceToast.fill(s.device === 'voice' ? s.toast : null);
      if (prev && s.device === 'voice' && s.toast !== prev.toast) fit();
    }

    mic.disabled = !s.micSupported;
    mic.title = s.micSupported ? (s.listening ? 'Listening. Tap to stop.' : 'Tap to speak') : 'Voice input needs a browser with speech recognition. Type instead.';
    mic.dataset['listening'] = String(s.listening);

    if (!prev || s.transcript !== prev.transcript) asked = askedOf(s.transcript);
    const list = suggestionsFor(s.conversation, s.approval, asked);
    const key = list.join('|');
    if (key !== lastChipsKey) {
      lastChipsKey = key;
      chips.replaceChildren(
        ...list.map((text) => {
          const lang = CHIP_LANG[text];
          if (!lang) return h('button', { type: 'button', class: 'chip', onclick: () => void app.say(text, 'suggestion'), text });
          return h(
            'button',
            { type: 'button', class: 'chip', 'aria-label': `${text}, in ${lang.name}`, onclick: () => void app.say(text, 'suggestion') },
            h('span', { lang: lang.lang, text }),
            h('span', { class: 'chip-note', 'aria-hidden': 'true', text: lang.name }),
          );
        }),
      );
    }
  }

  render(store.get(), null);
  store.subscribe((s, prev) => render(s, prev));
}
