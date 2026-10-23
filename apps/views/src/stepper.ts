// The guide's Card pattern: one device, one clear action per screen (design/DESIGN.md).
import './ui/zod-jitless.ts'; // must stay first: keeps zod from probing eval under the sandbox CSP
import './ui/tokens.css';
import './ui/base.css';
import './ui/panel.css';
import { runPanelView } from './ui/panel-view.ts';

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

runPanelView({
  name: 'stepper',
  accepts: ['diagnosis', 'explanation', 'plan', 'repair'],
  eyebrow: 'Diagnosis',
  waiting(input) {
    if (text(input.question)) return { eyebrow: 'What happened', title: 'Reading the logs', line: 'Looking at what your home recorded' };
    if (text(input.plan_id) || text(input.diagnosis_id) || text(input.issue_id) || text(input.explanation_id)) {
      return { eyebrow: 'Repair plan', title: 'Preparing the fix', line: 'Working out the changes, nothing is changed yet' };
    }
    const device = text(input.device);
    return { eyebrow: 'Diagnosis', title: device ?? 'Checking your device', line: 'Running the checks' };
  },
});
