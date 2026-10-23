// Test only: imports packages/router by path, the router apps/host runs a view's ui/message through. The
// views never depend on it at runtime.
import type { Finding, HomeCheckupOutput } from '@fixwright/protocol';
import { describe, expect, test } from 'vitest';
import { REPLIES, applyResult, initialState, isToolRoute, routeUtterance } from '../../../../packages/router/src/index.ts';
import { askWords, checkupCarousel } from '../../src/ui/checkup.ts';
import { fixture } from './load.ts';

const three = fixture<HomeCheckupOutput>('protocol/home_checkup');

/** Shapes the engine gives these findings (packages/engine/src/checkup.ts flapping, integration_error, unprotected). */
const authExpired: Finding = {
  issue_id: 'iss_01m52gb900au0000000',
  kind: 'integration_error',
  severity: 'high',
  title: 'Hue needs you to sign in again',
  detail: "The link to your Hue account expired, so 12 devices can't be reached. Signing in again from the app brings them back.",
  entity_ids: ['light.hallway_lamp'],
  fixable: false,
  action_label: 'Show me how',
};
const aquarium: Finding = {
  issue_id: 'iss_01m52gb900aq0000000',
  kind: 'unprotected_load',
  severity: 'high',
  title: 'Aquarium filter is not protected',
  detail: "It runs on outlet 2 of the Living Room Power Strip. Protect it and I'll never switch it off.",
  entity_ids: ['switch.living_room_strip_outlet_2', 'switch.living_room_strip'],
  fixable: false,
  action_label: 'Protect it',
};

const checkup: HomeCheckupOutput = { ...three, findings: [...three.findings, authExpired, aquarium] };
const state = applyResult(initialState(), { tool: 'home_checkup', arguments: {}, structuredContent: checkup });

describe("a card's words, routed the way apps/host routes a view's ui/message", () => {
  const asks = checkupCarousel(checkup, { canAsk: true }).items.filter((i) => i.action?.ask);

  test('every labelled finding that is not fixable asks, and nothing else does', () => {
    expect(asks.map((i) => i.key).sort()).toEqual(checkup.findings.filter((f) => !f.fixable && f.action_label).map((f) => f.issue_id).sort());
  });

  test.each([three.findings[2] as Finding, authExpired])('"$action_label" on "$title" gets its guidance back', (f) => {
    const r = routeUtterance(askWords(f), state);
    expect(isToolRoute(r)).toBe(false);
    expect('reply' in r && r.reply).toBe(`${REPLIES.notFixable} ${f.detail}`);
  });

  test('"Protect it" routes to protect_device for that load (the host asks the person first)', () => {
    const r = routeUtterance(askWords(aquarium), state);
    expect(isToolRoute(r) && [r.tool, r.arguments]).toEqual(['protect_device', { device: 'aquarium filter' }]);
  });
});
