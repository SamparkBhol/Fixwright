// Household settings with their defaults: quiet hours 22:00 to 07:00, human sensitivity 0.92 and
// specificity 0.95, no protected devices, topology inferred from the entity list.

import { DEFAULT_RELIABILITY } from './bayes.ts';
import type { EngineSettings } from './types.ts';
import { parseClock } from './util/time.ts';

export const DEFAULT_TZ = 'America/Los_Angeles';
export const DEFAULT_QUIET_HOURS = { start: '22:00', end: '07:00' } as const;

export function defaultSettings(overrides: Partial<EngineSettings> = {}): EngineSettings {
  const settings: EngineSettings = {
    tz: DEFAULT_TZ,
    quietHours: { ...DEFAULT_QUIET_HOURS },
    humanReliability: { ...DEFAULT_RELIABILITY },
    protected: [],
    ...overrides,
  };
  // Fail early on a bad zone or clock time instead of deep inside a diagnosis.
  new Intl.DateTimeFormat('en-US', { timeZone: settings.tz });
  parseClock(settings.quietHours.start);
  parseClock(settings.quietHours.end);
  return settings;
}
