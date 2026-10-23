// @fixwright/adapter-ha: the HomeAdapter for a real Home Assistant, over fetch and the
// standard WebSocket only, so the same code runs in Cloudflare workerd, Node 22 and the browser.

export { createHaAdapter, targetEntityIds } from './adapter.ts';
export type { HaAdapter, HaAdapterConfig } from './adapter.ts';
export {
  DEFAULT_DENY_DOMAINS,
  DEFAULT_UNSAFE_NAMES,
  ENTITY_SERVICE_DOMAINS,
  GARAGE_CLASSES,
  entityRefusal,
  forwardedTo,
  isValidEntityId,
  normalizeEntityId,
  reachRefusal,
  resolveIndirect,
  serviceRefusal,
  serviceTarget,
} from './guard.ts';
export type { GuardPolicy, Refused, ServiceTarget, TargetEntry } from './guard.ts';
export {
  haError,
  isHaError,
  toProtocolError,
  kindForStatus,
  kindForWsCode,
  HA_ERROR_KINDS,
  RESTART_SPEECH,
  UNVERIFIED_SPEECH,
} from './errors.ts';
export type { HaError, HaErrorKind, Refusal } from './errors.ts';
export { createAuthGate, DEFAULT_AUTH_HOLD_MS } from './auth.ts';
export type { AuthGate } from './auth.ts';
export { createRest, normalizeBaseUrl, backoffMs, DEFAULT_RETRY, DEFAULT_TIMEOUT_MS } from './rest.ts';
export type { HaRest, RestOptions, RequestOptions, RetryPolicy, FetchLike, Sleep } from './rest.ts';
export { connectSocket, websocketUrl, parseFrame, eventData } from './socket.ts';
export type { HaSocket, SocketOptions, WebSocketLike, WsConnector } from './socket.ts';
export {
  causeOf,
  cloudSensorCandidates,
  cloudStatusFrom,
  CLOUD_UNKNOWN_SOURCE,
  contextFromRow,
  countFlaps,
  expectedFriendlyName,
  historyTransitions,
  inferTransport,
  isBatterySensor,
  isUptimeSensor,
  mergeEvents,
  normalizePowerOn,
  signalsFrom,
  toEntity,
  toIntegrationStatus,
  toIso,
  uptimeResets,
} from './map.ts';
export type { ManifestInfo, Transition } from './map.ts';
export type * from './ha-types.ts';
