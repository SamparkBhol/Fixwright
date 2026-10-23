// Placeholder MCP Apps view served by the mock server when apps/views/dist is not built yet.
// It speaks the MCP Apps postMessage protocol by hand (no SDK, no zod, so no CSP eval issues):
// ui/initialize -> ui/notifications/initialized -> tool-input / tool-result -> tools/call from buttons.
// One script renders all three views (stepper, carousel, repair card) from structuredContent only.

type Json = Record<string, unknown>;
type DeviceClass = 'large' | 'small' | 'phone' | 'voice';

interface Ctx {
  theme: 'light' | 'dark';
  deviceClass: DeviceClass;
  width: number;
  height: number;
  /** The host clock (dev.fixwright/now), else the browser's. */
  nowMs: number | null;
}

const ctx: Ctx = { theme: 'dark', deviceClass: 'large', width: 1280, height: 800, nowMs: null };
/** Repairs this view already asked refresh_view about, so a due check is asked for once. */
const refreshed = new Set<string>();
let current: Json | null = null;
let busy = false;
let renders = 0;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : []);
const s = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

function post(msg: Json): void {
  window.parent.postMessage({ jsonrpc: '2.0', ...msg }, '*');
}

function request(method: string, params: Json): Promise<Json> {
  const id = nextId++;
  post({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function applyContext(hc: unknown): void {
  if (!isObj(hc)) return;
  if (hc['theme'] === 'light' || hc['theme'] === 'dark') ctx.theme = hc['theme'];
  const dc = hc['dev.fixwright/deviceClass'];
  if (dc === 'large' || dc === 'small' || dc === 'phone' || dc === 'voice') ctx.deviceClass = dc;
  const now = typeof hc['dev.fixwright/now'] === 'string' ? Date.parse(hc['dev.fixwright/now']) : Number.NaN;
  if (Number.isFinite(now)) ctx.nowMs = now;
  const dim = hc['containerDimensions'];
  if (isObj(dim)) {
    const w = dim['width'] ?? dim['maxWidth'];
    const h = dim['height'] ?? dim['maxHeight'];
    if (typeof w === 'number') ctx.width = w;
    if (typeof h === 'number') ctx.height = h;
  }
  document.documentElement.dataset['theme'] = ctx.theme;
  document.documentElement.dataset['device'] = ctx.deviceClass;
  document.documentElement.style.colorScheme = ctx.theme;
  layout();
  refreshIfDue();
}

/** Like apps/views: once the host clock passes a repair's next check, ask for its latest result. */
function refreshIfDue(): void {
  const sc = current;
  if (!sc || busy || sc['state'] !== 'applied' || typeof sc['repair_id'] !== 'string') return;
  const due = Date.parse(s(sc['next_check_at']));
  const now = ctx.nowMs ?? Date.now();
  if (!Number.isFinite(due) || due > now || refreshed.has(sc['repair_id'])) return;
  refreshed.add(sc['repair_id']);
  void callTool('refresh_view', { ref_id: sc['repair_id'] });
}

/** Design guide: a 768x480 base canvas scaled to the display (root zoom 1.667 on a 1280x800 screen). */
function layout(): void {
  const canvas = document.getElementById('canvas');
  if (!canvas) return;
  if (ctx.deviceClass === 'phone') {
    canvas.style.zoom = '1';
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
  } else {
    const zoom = Math.min(ctx.width / 768, ctx.height / 480);
    canvas.style.zoom = String(Math.round(zoom * 1000) / 1000);
    canvas.style.width = '768px';
    canvas.style.height = '480px';
  }
  requestAnimationFrame(reportSize);
}

function reportSize(): void {
  const el = document.getElementById('canvas');
  if (!el) return;
  const r = el.getBoundingClientRect();
  post({ method: 'ui/notifications/size-changed', params: { width: Math.ceil(r.width), height: Math.ceil(r.height) } });
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(label: string, kind: 'primary' | 'secondary', onClick: () => void): HTMLButtonElement {
  const b = h('button', `btn ${kind}`, label);
  b.type = 'button';
  b.addEventListener('click', () => {
    if (!busy) onClick();
  });
  return b;
}

async function callTool(name: string, args: Json): Promise<void> {
  busy = true;
  document.body.dataset['busy'] = '1';
  const before = renders;
  try {
    const result = await request('tools/call', { name, arguments: args });
    const sc = result['structuredContent'];
    if (isObj(sc)) render(sc);
  } catch (e) {
    // A newer result from the host wins: after a declined approval the host sends again what is on
    // screen, so there is nothing to report.
    if (renders === before) showNote(e instanceof Error ? e.message : 'That did not go through.');
  } finally {
    busy = false;
    delete document.body.dataset['busy'];
  }
}

function showNote(text: string): void {
  const note = document.getElementById('note');
  if (note) note.textContent = text;
}

function header(eyebrow: string, title: string, chip?: { text: string; tone: string }): HTMLElement {
  const head = h('header', 'head');
  const left = h('div');
  left.append(h('div', 'eyebrow', eyebrow), h('h1', 'title', title));
  head.append(left);
  if (chip) head.append(h('span', `chip ${chip.tone}`, chip.text));
  return head;
}

const VERDICT_CHIP: Record<string, { text: string; tone: string }> = {
  confirmed: { text: 'Confirmed', tone: 'good' },
  likely: { text: 'Likely', tone: 'warn' },
  cant_tell: { text: "Can't tell", tone: 'muted' },
};

function probeChips(probes: Json[]): HTMLElement {
  const row = h('div', 'probes');
  for (const p of probes) {
    const outcome = s(p['outcome']);
    const chip = h('span', `probe ${outcome}`);
    chip.append(h('i', 'dot'), document.createTextNode(s(p['label'])));
    chip.title = s(p['detail']);
    row.append(chip);
  }
  return row;
}

function bars(hyps: Json[]): HTMLElement {
  const box = h('div', 'bars');
  for (const hyp of hyps) {
    const pct = Math.round(Number(hyp['p'] ?? 0) * 100);
    const row = h('div', 'bar');
    const label = h('div', 'bar-label');
    label.append(h('span', '', s(hyp['label'])), h('b', '', `${pct}%`));
    const track = h('div', 'track');
    const fill = h('div', 'fill');
    fill.style.width = `${pct}%`;
    track.append(fill);
    row.append(label, track);
    box.append(row);
  }
  return box;
}

function renderDiagnosis(sc: Json): HTMLElement[] {
  const target = isObj(sc['target']) ? sc['target'] : {};
  const verdict = isObj(sc['verdict']) ? sc['verdict'] : null;
  const question = isObj(sc['question']) ? sc['question'] : null;
  const chip = verdict ? VERDICT_CHIP[s(verdict['level'])] : { text: 'Checking', tone: 'info' };
  const out: HTMLElement[] = [header('Diagnosis', s(target['name']) || 'Your device', chip)];
  const body = h('div', 'cols');
  body.append(probeChips(arr(sc['probes'])), bars(arr(sc['hypotheses']).slice(0, 3)));
  out.push(body);
  const foot = h('footer', 'foot');
  if (question) {
    foot.append(h('p', 'ask', s(question['text'])));
    const actions = h('div', 'actions');
    const answer = (text: string) => () =>
      void callTool('diagnose_answer', { diagnosis_id: s(sc['diagnosis_id']), question_id: s(question['question_id']), answer: text });
    actions.append(button('Yes', 'primary', answer('yes')), button('No', 'secondary', answer('no')));
    foot.append(actions);
  } else if (verdict) {
    const claims = arr(verdict['claims']).map((c) => s(c['text'])).join(' ');
    foot.append(h('p', 'ask', claims || s(verdict['label'])));
    if (verdict['fix_available'] === true) {
      const actions = h('div', 'actions');
      actions.append(button('Show the fix', 'primary', () => void callTool('repair_plan', { diagnosis_id: s(sc['diagnosis_id']) })));
      foot.append(actions);
    }
  }
  out.push(foot);
  return out;
}

function renderExplanation(sc: Json): HTMLElement[] {
  const verdict = isObj(sc['verdict']) ? sc['verdict'] : {};
  const out: HTMLElement[] = [header('What happened', s(verdict['label']) || 'Explanation', VERDICT_CHIP[s(verdict['level'])])];
  const list = h('ol', 'timeline');
  for (const t of arr(sc['timeline'])) {
    const li = h('li');
    const time = new Date(s(t['ts']));
    const stamp = Number.isNaN(time.getTime())
      ? ''
      : time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/Los_Angeles' });
    li.append(h('time', '', stamp), h('span', '', s(t['label'])));
    list.append(li);
  }
  out.push(list);
  const fix = isObj(sc['suggested_fix']) ? sc['suggested_fix'] : null;
  const foot = h('footer', 'foot');
  foot.append(h('p', 'ask', fix ? s(fix['label']) : ''));
  if (fix) {
    const actions = h('div', 'actions');
    actions.append(button('Show the fix', 'primary', () => void callTool('repair_plan', { issue_id: s(fix['issue_id']) })));
    foot.append(actions);
  }
  out.push(foot);
  return out;
}

function steps(list: Json[]): HTMLElement {
  const ol = h('ol', 'steps');
  for (const st of list) {
    const li = h('li', `step ${s(st['status'])}`);
    const text = h('div');
    text.append(h('span', 'step-label', s(st['label'])));
    if (st['read_back']) text.append(h('span', 'read back', s(st['read_back'])));
    li.append(h('i', 'tick'), text);
    ol.append(li);
  }
  return ol;
}

function renderPlan(sc: Json): HTMLElement[] {
  const out: HTMLElement[] = [header('Dry run', 'Here is the fix', { text: 'Nothing changed yet', tone: 'info' })];
  const diff = h('ul', 'diff');
  for (const line of Array.isArray(sc['diff_lines']) ? sc['diff_lines'] : []) diff.append(h('li', '', s(line)));
  out.push(diff, steps(arr(sc['steps'])));
  const foot = h('footer', 'foot');
  foot.append(h('p', 'ask', 'One clear yes applies it. Every step is read back.'));
  const actions = h('div', 'actions');
  actions.append(button('Fix it', 'primary', () => void callTool('repair_apply', { plan_id: s(sc['plan_id']), confirm_token: s(sc['confirm_token']) })));
  foot.append(actions);
  out.push(foot);
  return out;
}

const REPAIR_CHIP: Record<string, { text: string; tone: string }> = {
  applied: { text: 'Applied', tone: 'good' },
  confirmed: { text: 'Confirmed', tone: 'good' },
  rolled_back: { text: 'Rolled back', tone: 'warn' },
  failed: { text: 'Failed', tone: 'bad' },
  regressed: { text: 'Regressed', tone: 'bad' },
  undone: { text: 'Undone', tone: 'muted' },
};

function renderRepair(sc: Json): HTMLElement[] {
  const state = s(sc['state']);
  const title = state === 'undone' ? 'Put back' : state === 'confirmed' ? 'Repair confirmed' : 'Fixed and checked';
  const out: HTMLElement[] = [header('Repair', title, REPAIR_CHIP[state])];
  out.push(steps(arr(sc['steps'])));
  const foot = h('footer', 'foot');
  const checks = arr(sc['checks']);
  const last = checks[checks.length - 1];
  const next = s(sc['next_check_at']);
  const when = next
    ? new Date(next).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })
    : '';
  foot.append(h('p', 'ask', last ? s(last['detail']) : when ? `Next check ${when}` : ''));
  if (sc['undo_available'] === true) {
    const actions = h('div', 'actions');
    actions.append(button('Undo', 'secondary', () => void callTool('undo', { repair_id: s(sc['repair_id']) })));
    foot.append(actions);
  }
  out.push(foot);
  return out;
}

const SEVERITY: Record<string, string> = { high: 'bad', medium: 'warn', low: 'muted' };

function renderCheckup(sc: Json): HTMLElement[] {
  const findings = arr(sc['findings']);
  const out: HTMLElement[] = [header('Checkup', `${findings.length} things to look at`)];
  const row = h('div', 'carousel');
  for (const f of findings) {
    const card = h('article', `finding ${SEVERITY[s(f['severity'])] ?? 'muted'}`);
    card.append(h('span', 'sev', s(f['severity'])), h('h2', '', s(f['title'])), h('p', '', s(f['detail'])));
    if (f['fixable'] === true) {
      card.append(button(s(f['action_label']) || 'Fix it', 'primary', () => void callTool('repair_plan', { issue_id: s(f['issue_id']) })));
    }
    row.append(card);
  }
  out.push(row);
  return out;
}

function render(sc: Json): void {
  current = sc;
  renders++;
  const canvas = document.getElementById('canvas');
  if (!canvas) return;
  let parts: HTMLElement[];
  let kind: string;
  if (Array.isArray(sc['findings'])) [kind, parts] = ['carousel', renderCheckup(sc)];
  else if (typeof sc['repair_id'] === 'string') [kind, parts] = ['repair-card', renderRepair(sc)];
  else if (typeof sc['confirm_token'] === 'string') [kind, parts] = ['plan', renderPlan(sc)];
  else if (typeof sc['explanation_id'] === 'string') [kind, parts] = ['explain', renderExplanation(sc)];
  else if (typeof sc['diagnosis_id'] === 'string') [kind, parts] = ['diagnosis', renderDiagnosis(sc)];
  else [kind, parts] = ['speech', [header('Fixwright', s(sc['speech']))]];
  canvas.dataset['kind'] = kind;
  const note = h('div', 'note');
  note.id = 'note';
  canvas.replaceChildren(...parts, note);
  requestAnimationFrame(reportSize);
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  const msg = event.data as Json | null;
  if (!isObj(msg) || msg['jsonrpc'] !== '2.0') return;
  const method = msg['method'];
  const id = msg['id'];
  if (typeof method !== 'string' && typeof id === 'number') {
    const p = pending.get(id);
    pending.delete(id);
    if (!p) return;
    if (isObj(msg['error'])) p.reject(new Error(s(msg['error']['message'])));
    else p.resolve(isObj(msg['result']) ? msg['result'] : {});
    return;
  }
  const params = isObj(msg['params']) ? msg['params'] : {};
  if (method === 'ui/notifications/tool-result' && isObj(params['structuredContent'])) {
    render(params['structuredContent']);
    refreshIfDue();
  }
  else if (method === 'ui/notifications/host-context-changed') applyContext(params);
  else if (method === 'ui/resource-teardown' || method === 'ping') post({ id, result: {} });
  else if (typeof method === 'string' && id !== undefined) post({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});

async function start(): Promise<void> {
  const result = await request('ui/initialize', {
    appInfo: { name: 'fixwright-placeholder-view', version: '0.1.0' },
    appCapabilities: { availableDisplayModes: ['inline'] },
    protocolVersion: '2026-01-26',
  });
  applyContext(result['hostContext']);
  post({ method: 'ui/notifications/initialized', params: {} });
  if (current) render(current);
}

void start();
