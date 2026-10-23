// What the approval sheet says for each change a view can ask for. Pure, so the wording is tested
// without a browser. The sheet is host chrome: a view cannot draw it, skip it or answer it.

import type { ConversationState } from '@fixwright/router';
import type { Approval } from './state.ts';
import type { ApprovalRequest } from './view-host.ts';

const MAX_SAID = 80;

const quote = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return `“${t.length > MAX_SAID ? `${t.slice(0, MAX_SAID - 1).trimEnd()}…` : t}”`;
};

const firstUpper = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * The person's turn when they tap a view's button: shown in the captions and the transcript, so the
 * reply that follows is paired with what they did. The host knows the tool, not the button's label,
 * so the words describe the action.
 */
export function tapWords(tool: string, args: Record<string, unknown>): string {
  const device = typeof args['device'] === 'string' && args['device'].trim() ? args['device'].trim() : 'device';
  switch (tool) {
    case 'diagnose_answer': {
      const answer = typeof args['answer'] === 'string' ? args['answer'].replace(/\s+/g, ' ').trim() : '';
      return answer ? `${firstUpper(answer.slice(0, 80))}${/[.!?]$/.test(answer) ? '' : '.'}` : 'Answered on the screen.';
    }
    case 'repair_plan':
      return 'Show me the fix.';
    case 'repair_apply':
      return 'Fix it.';
    case 'undo':
      return 'Undo it.';
    case 'repair_status':
      return 'How is the fix doing?';
    case 'switch_device':
      return `Turn ${args['on'] === true ? 'on' : 'off'} the ${device}.`;
    case 'protect_device':
      return args['protect'] === false ? `Stop protecting the ${device}.` : `Protect the ${device}.`;
    case 'home_checkup':
      return 'Check the house.';
    default:
      return 'Tapped on the screen.';
  }
}

export function approvalFor(req: ApprovalRequest, conv: ConversationState): Approval {
  const a = req.args;
  const device = typeof a['device'] === 'string' && a['device'].trim() ? a['device'].trim() : 'device';
  const note = req.via === 'message' && req.said ? `The screen sent ${quote(req.said)} for you.` : null;
  const base = { tool: req.tool.name, note };
  switch (req.tool.name) {
    case 'repair_apply': {
      const plan = conv.pendingPlan;
      const lines = plan && plan.plan_id === a['plan_id'] && plan.diff_lines.length > 0 ? plan.diff_lines : ['Fixwright will apply the planned repair and read back every step.'];
      return { ...base, title: 'Apply this fix?', lines, confirm: 'Yes, apply it', footer: 'Nothing changes until you say yes. Every step is read back, and you can undo it.' };
    }
    case 'undo':
      return { ...base, title: 'Undo this repair?', lines: ['Every change from the repair is put back and read back.'], confirm: 'Yes, undo it', footer: 'Nothing changes until you say yes.' };
    case 'switch_device': {
      const state = a['on'] === true ? 'on' : 'off';
      return { ...base, title: `Turn ${state} the ${device}?`, lines: [`Fixwright will switch the ${device} ${state}.`], confirm: `Yes, turn it ${state}`, footer: 'Nothing changes until you say yes.' };
    }
    case 'protect_device':
      return a['protect'] === false
        ? { ...base, title: `Stop protecting the ${device}?`, lines: ['Fixwright may switch it off again when you ask.'], confirm: 'Yes, stop protecting it', footer: 'Nothing changes until you say yes.' }
        : { ...base, title: `Protect the ${device}?`, lines: ['Fixwright will never switch it off.'], confirm: 'Yes, protect it', footer: 'Nothing changes until you say yes.' };
    default:
      return { ...base, title: `Allow ${req.tool.title ?? req.tool.name}?`, lines: [], confirm: 'Allow', footer: 'Nothing changes until you say yes.' };
  }
}
