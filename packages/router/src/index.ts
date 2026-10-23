// @fixwright/router: deterministic utterance -> tool routing plus the conversation state machine.
// Pure: no I/O, no clock, no randomness. Runs in Node 22, workerd and the browser. The host
// simulator bundles it; the server's /assistant/route can use the same code.

export { routeUtterance, consentOf, isToolRoute, REPLIES, noRepairFor, repairForText } from './route.ts';
export type { Route, ToolRoute, ReplyRoute, Intent } from './route.ts';
export { initialState, applyResult, clearPending, MAX_REPAIRS } from './state.ts';
export type {
  ConversationState,
  PendingQuestion,
  PendingPlan,
  PendingOffer,
  OfferKind,
  FindingRef,
  LastIds,
  RepairRef,
  ToolOutcome,
} from './state.ts';
export { normalize, stripInvocation, cleanDevice } from './normalize.ts';
