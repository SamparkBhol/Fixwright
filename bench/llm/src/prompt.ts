import { LLM_CAUSE_IDS, type LlmCauseId } from './verdict.ts';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface DiagnosisInput {
  symptom: string;
  /** Raw log text exactly as the baseline sees it (entities, logbook rows, integration states). */
  log: string;
  /** Answers a person gave to questions, for the B2 baseline. Empty for B1. */
  humanAnswers?: readonly { question: string; answer: string }[];
}

// Keyed by LlmCauseId: a cause added to the protocol fails the typecheck here until it gets a hint.
const CAUSE_HINTS: Record<LlmCauseId, string> = {
  stale_duplicate: 'the spoken name points at an old, offline copy of a re-paired device',
  device_power_lost: 'the device has no power while its siblings are fine',
  radio_link_weak: 'weak Zigbee or Wi-Fi link (low link quality or RSSI, flapping)',
  hub_down: 'hub or bridge unreachable, every entity of that integration unavailable',
  vendor_cloud_outage: 'the vendor cloud is degraded or down',
  account_link_expired: 'integration in setup_error because its account link or auth expired',
  power_on_default_on: 'after a power restore devices come back on because power_on_behavior is on',
  name_collision: 'two different devices answer to the same spoken name',
  dead_trigger: 'an automation references an entity that no longer exists',
  wifi_network_changed: 'Wi-Fi devices offline after a router or network name change',
  unknown: 'the log does not support any single cause',
};

export function systemPrompt(): string {
  const causes = LLM_CAUSE_IDS.map((id) => `- ${id}: ${CAUSE_HINTS[id]}`).join('\n');
  return [
    'You diagnose smart home faults from raw Home Assistant style logs.',
    'Pick exactly one root cause id from this list:',
    causes,
    'Reply with only a JSON object: {"cause_id": string, "confidence": number from 0 to 1, "explanation": string}.',
    'confidence is your probability that cause_id is right. Use 0.9 or more only when the log proves it.',
    'explanation is one or two plain sentences that cite the log lines you relied on.',
  ].join('\n');
}

export function userPrompt(input: DiagnosisInput): string {
  const parts = [`Symptom reported by the person: ${input.symptom}`, '', 'Log:', input.log.trimEnd()];
  if (input.humanAnswers && input.humanAnswers.length > 0) {
    parts.push('', 'Answers the person gave:');
    for (const qa of input.humanAnswers) parts.push(`- Q: ${qa.question} A: ${qa.answer}`);
  }
  return parts.join('\n');
}

export function diagnosisMessages(input: DiagnosisInput): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(input) },
  ];
}
