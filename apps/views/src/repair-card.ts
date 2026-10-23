import './ui/zod-jitless.ts'; // must stay first: keeps zod from probing eval under the sandbox CSP
import './ui/tokens.css';
import './ui/base.css';
import './ui/panel.css';
import { runPanelView } from './ui/panel-view.ts';

runPanelView({
  name: 'repair-card',
  accepts: ['repair'],
  eyebrow: 'Repair',
  waiting(input) {
    const applying = typeof input.plan_id === 'string';
    return applying
      ? { eyebrow: 'Repair', title: 'Fixing it', line: 'Applying each step and reading it back' }
      : { eyebrow: 'Repair', title: 'Checking the repair', line: 'Getting the latest results' };
  },
});
