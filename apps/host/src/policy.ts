// What a view may do through the bridge. The MCP Apps spec says a host MUST reject view calls to
// tools whose visibility lacks "app" (ext-apps 2.0.3's own forwarding does not check it),
// and MAY ask the person before running them. Fixwright's rule is one explicit yes before any change
// to the house, so every tool that is not read only asks first, with two exceptions: answering the
// question already on screen is the person's own input, and a diagnosis only flashes the device and puts
// it back.
//
// The same rule covers a view's ui/message. Its text is routed like something the person said, so a
// view that sends "yes" while a plan waits would otherwise spend the plan's confirm_token. Whatever a
// view starts, by tools/call or by message, needs the person's own yes before it changes the house.

import type { Tool } from '@modelcontextprotocol/client';

type Visibility = 'model' | 'app';

export function toolVisibility(tool: Pick<Tool, '_meta'>): Visibility[] {
  const ui = (tool._meta as { ui?: { visibility?: unknown } } | undefined)?.ui;
  const v = ui?.visibility;
  if (Array.isArray(v)) return v.filter((x): x is Visibility => x === 'model' || x === 'app');
  return ['model', 'app'];
}

export function toolResourceUri(tool: Pick<Tool, '_meta'>): string | null {
  const meta = tool._meta as { ui?: { resourceUri?: unknown }; 'ui/resourceUri'?: unknown } | undefined;
  const uri = meta?.ui?.resourceUri ?? meta?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : null;
}

export type ViewCallDecision = { allow: true; approval: boolean } | { allow: false; reason: string };

/**
 * Tools a view may run without the sheet although they are not read only: diagnose_answer carries the
 * person's answer to the question on screen, and diagnose's only write is the flash test, which puts the
 * device back the way it was.
 */
const NO_SHEET = new Set(['diagnose', 'diagnose_answer']);

/** True when running this tool on a view's behalf needs the person's yes first. */
export function requiresApproval(tool: Pick<Tool, 'name' | 'annotations'>): boolean {
  return tool.annotations?.readOnlyHint !== true && !NO_SHEET.has(tool.name);
}

/**
 * A call a view makes on its own, not for the person: an app only tool such as refresh_view (the
 * repair card picking up the morning check). It is neither the person's turn nor a reply to speak.
 */
export function isBackgroundCall(tool: Pick<Tool, '_meta'>): boolean {
  return !toolVisibility(tool).includes('model');
}

/**
 * The repair_id of a result whose next morning check is due by `nowMs`: a repair card shown again
 * now (back from voice only, after a clock jump) would be out of date, so the host asks refresh_view
 * first, the same rule apps/views uses for a card that is on screen.
 */
export function dueRepairRef(structuredContent: unknown, nowMs: number): string | null {
  const sc = structuredContent as { state?: unknown; next_check_at?: unknown; repair_id?: unknown } | null | undefined;
  if (!sc || sc.state !== 'applied' || typeof sc.repair_id !== 'string' || typeof sc.next_check_at !== 'string') return null;
  const due = Date.parse(sc.next_check_at);
  return Number.isFinite(due) && due <= nowMs ? sc.repair_id : null;
}

export function decideViewCall(tool: Tool | undefined, name: string): ViewCallDecision {
  if (!tool) return { allow: false, reason: `The view asked for a tool this server does not have: ${name}.` };
  if (!toolVisibility(tool).includes('app')) return { allow: false, reason: `${name} is not callable from a view.` };
  return { allow: true, approval: requiresApproval(tool) };
}
