// POST /assistant/route: the deterministic router (@fixwright/router) behind an HTTP call, for hosts that
// route on the server (?router=server). The conversation state comes from the client, so it is rebuilt
// field by field from known shapes before the router sees it.

import { initialState, routeUtterance, type ConversationState, type Route } from '@fixwright/router';

export const MAX_UTTERANCE = 500;

const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function sanitizeState(raw: unknown): ConversationState {
  const s = initialState();
  const o = obj(raw);
  if (!o) return s;
  if (typeof o['turn'] === 'number' && Number.isInteger(o['turn']) && o['turn'] >= 0) s.turn = o['turn'];
  const q = obj(o['pendingQuestion']);
  if (q && str(q['diagnosis_id']) && str(q['question_id']) && str(q['text'], 600)) {
    s.pendingQuestion = { diagnosis_id: q['diagnosis_id'] as string, question_id: q['question_id'] as string, text: q['text'] as string };
  }
  const offer = obj(o['pendingOffer']);
  if (offer && ['diagnosis', 'issue', 'explanation'].includes(offer['kind'] as string) && str(offer['id'])) {
    s.pendingOffer = { kind: offer['kind'] as 'diagnosis' | 'issue' | 'explanation', id: offer['id'] as string, label: str(offer['label']) };
  }
  const plan = obj(o['pendingPlan']);
  if (plan && str(plan['plan_id']) && str(plan['confirm_token'])) {
    const lines = Array.isArray(plan['diff_lines']) ? plan['diff_lines'].filter((l): l is string => typeof l === 'string' && l.length <= 600).slice(0, 40) : [];
    s.pendingPlan = { plan_id: plan['plan_id'] as string, confirm_token: plan['confirm_token'] as string, expires_at: str(plan['expires_at']), diff_lines: lines };
  }
  if (Array.isArray(o['findings'])) {
    for (const f of o['findings'].slice(0, 5)) {
      const fo = obj(f);
      if (!fo || !str(fo['issue_id']) || !str(fo['title']) || typeof fo['fixable'] !== 'boolean') continue;
      s.findings.push({
        issue_id: fo['issue_id'] as string,
        title: fo['title'] as string,
        fixable: fo['fixable'],
        ...(str(fo['kind']) ? { kind: fo['kind'] as string } : {}),
        ...(str(fo['detail'], 600) ? { detail: fo['detail'] as string } : {}),
      });
    }
  }
  const last = obj(o['last']);
  if (last) for (const k of Object.keys(s.last) as (keyof ConversationState['last'])[]) s.last[k] = str(last[k]);
  s.lastDevice = str(o['lastDevice'], 100);
  return s;
}

export type RouteBody = { ok: true; route: Route } | { ok: false; error: string };

export function routeBody(body: Record<string, unknown>): RouteBody {
  const utterance = body['utterance'];
  if (typeof utterance !== 'string' || utterance.trim() === '') return { ok: false, error: 'utterance must be a string that is not empty.' };
  if (utterance.length > MAX_UTTERANCE) return { ok: false, error: `utterance must be at most ${MAX_UTTERANCE} characters.` };
  return { ok: true, route: routeUtterance(utterance, sanitizeState(body['state'])) };
}
