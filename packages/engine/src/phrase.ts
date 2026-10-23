// Deterministic phrasing. Every line Fixwright says comes from a template here, so the golden
// path wording is exact and testable. Facts are passed in already computed from events;
// templates only arrange words. An optional phraser hook may restyle lines (see claims.ts).

import { PROBLEM_DEFAULTS, type ProblemCode } from '@fixwright/protocol';
import { capitalize, isNumberedName, isPluralName, joinAnd, lowerName, numberWord, plural, sentenceCase } from './util/text.ts';

type None = Record<string, never>;

const countCap = (n: number): string => capitalize(numberWord(n));
const timesWord = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${numberWord(n)} times`);
const allCommands = (n: number): string => (n === 1 ? 'the one command it got' : n === 2 ? 'both commands it got' : `all ${n} commands`);
/** Ends a sentence once, even when it already ends in "a.m.". */
const stop = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Spoken names for causes inside a sentence ("It's most likely a weak signal or a power problem."). */
export const CAUSE_SPOKEN: Readonly<Record<string, string>> = {
  stale_duplicate: 'an old copy of the device',
  device_power_lost: 'a power problem',
  radio_link_weak: 'a weak signal',
  hub_down: 'the hub',
  vendor_cloud_outage: "the maker's cloud",
  account_link_expired: 'an expired account link',
  power_on_default_on: 'its power on setting',
  name_collision: 'two devices sharing a name',
  dead_trigger: 'an automation using a removed device',
  wifi_network_changed: 'a Wi-Fi change',
  unknown: "something I can't see from here",
};

/** device_power_lost on a battery device whose battery reads low. */
export const BATTERY_SPOKEN = 'a flat battery';

/** What a fault that does not fit the complaint cannot do, by the kind of complaint. */
const CANNOT: Readonly<Record<string, string>> = {
  unresponsive: 'stop it from answering',
  unexpected_on: 'switch it on by itself',
  wrong_device: 'make the wrong device answer',
  automation: 'stop the automation',
  unknown: 'cause this',
};

const TEMPLATES = {
  dx_passive_summary: (p: { parts: string[] }) => `${capitalize(joinAnd(p.parts))}.`,
  dx_ask_flash: (p: { name: string }) => `I'll flash the ${p.name} twice. Did it blink?`,
  dx_ask_flash_click: (p: { name: string }) => `I'll switch the ${p.name} on and off twice. Did you hear it click?`,
  dx_ask_flash_start: (p: { name: string }) => `I'll switch the ${p.name} on and off twice. Did you hear it start?`,
  dx_reask_flash: (p: { name: string }) => `I flashed it again. Just yes or no, did the ${p.name} blink?`,
  dx_reask_flash_click: (p: { name: string }) => `I switched it again. Just yes or no, did you hear the ${p.name}?`,
  // When the flash cannot repeat (quiet hours without consent), the question is about the flash already done.
  dx_recall_flash: (p: { name: string }) => `Just yes or no, did the ${p.name} blink when I flashed it?`,
  dx_recall_click: (p: { name: string }) => `Just yes or no, did you hear the ${p.name} when I switched it?`,
  dx_ask_wall_switch: (p: { noun: string }) => `Is the ${p.noun}'s wall switch on?`,
  dx_ask_plugged_in: (p: { name: string }) => `Is the ${p.name} plugged in and switched on at the wall?`,
  dx_reask_power: (p: { name: string }) => `Just yes or no. Is the ${p.name} getting power, with its wall switch on?`,
  dx_ask_router: (_: None) => 'Did your Wi-Fi router or its name change recently?',
  dx_reask_router: (_: None) => 'Just yes or no. Did you get a new router, or change the Wi-Fi name or password?',
  dx_ask_consent: (p: { name: string }) => `It's late, so I'll ask first. Can I flash the ${p.name} twice to test it?`,
  dx_reask_consent: (p: { name: string }) => `Just yes or no. Can I flash the ${p.name} twice now?`,
  dx_guided_intro: (p: { name: string }) => `I can't see the ${p.name} from here, so I'll ask you a quick question.`,
  dx_quiet_declined: (_: None) => "Okay, I won't flash anything right now.",

  dx_offer_fix: (_: None) => 'Want me to fix that?',
  // A likely verdict names its cause, so the voice only path hears what it is, not only how sure.
  dx_likely: (p: { cause: string }) => `It's most likely ${p.cause}, but I'm not certain.`,
  dx_cant_tell: (p: { causes: string[] }) =>
    p.causes.length > 1 ? `I can't tell yet. It's most likely ${joinAnd(p.causes).replace(/ and ([^,]+)$/, ' or $1')}.` : "I can't tell yet.",
  dx_settle_flash: (_: None) => 'If I can flash it while you watch, I can tell for sure.',
  dx_settle_switch: (_: None) => 'Checking its wall switch would settle it.',
  dx_settle_router: (_: None) => 'Knowing whether your router changed would settle it.',
  dx_settle_generic: (_: None) => "If it happens again, ask me right away and I'll test it while it's happening.",
  // The device works when tested, so nothing points at a cause (an intermittent fault, or one outside the home).
  dx_cant_tell_works: (_: None) => "So I can't tell what went wrong before.",
  // A real fault that cannot explain the complaint (an old copy does not switch a lamp on).
  dx_unrelated_fault: (p: { cause: string; complaint: string; also?: boolean }) =>
    `I ${p.also === true ? 'also found' : 'did find'} ${p.cause}, but that wouldn't ${CANNOT[p.complaint] ?? CANNOT['unknown']}.`,

  // Guidance for causes the person fixes. A check is promised only when one is scheduled (followup.ts).
  guide_power: (p: { name: string; check: boolean }) =>
    `Switch the ${p.name} back on at the wall${p.check ? ", and I'll check that it comes back." : '.'}`,
  guide_battery: (p: { name: string; check: boolean }) =>
    `Put a fresh battery in the ${p.name}${p.check ? ", and I'll check that it comes back." : '.'}`,
  guide_battery_seat: (p: { name: string; check: boolean }) =>
    `Check that the battery in the ${p.name} is seated properly${p.check ? ", and I'll check that it comes back." : '.'}`,
  guide_radio: (p: { name: string; check: boolean }) =>
    `Moving the ${p.name} closer to the hub or router, or adding a plugged in repeater nearby, usually fixes this.${
      p.check ? " I'll check on it tomorrow morning." : ''
    }`,
  guide_cloud: (p: { check: boolean }) =>
    p.check
      ? "There's nothing to fix at home. I'll check again later and tell you when it's back."
      : "There's nothing to fix at home. It should work again once the maker's service is back.",
  guide_account: (p: { check: boolean }) => `Sign in to that account again from its app${p.check ? ", and I'll check the link." : '.'}`,
  guide_power_on: (p: { name: string }) => `You can set the ${p.name} to remember whether it was on or off from its maker's app.`,
  guide_wifi: (p: { check: boolean; count: number }) =>
    `Each Wi-Fi device needs the new network name and password, set from its maker's app.${
      p.check ? ` I'll check that ${p.count === 1 ? 'it comes' : 'they come'} back.` : ''
    }`,

  claim_works: (p: { noun: string }) => `The ${p.noun} works.`,
  claim_online_answers: (p: { noun: string }) => `The online copy of the ${p.noun} answers commands.`,
  claim_stale: (p: { name: string; date: string }) => stop(`The name ${p.name} still points at an old copy of it that went offline on ${p.date}`),
  claim_stale_nodate: (p: { name: string }) => `The name ${p.name} still points at an old copy of it that is offline.`,
  claim_offline_since: (p: { name: string; since: string }) => stop(`The ${p.name} has been offline ${p.since}`),
  /** Names the device when nothing said before it did. */
  claim_switch_off: (p: { name?: string }) => (p.name !== undefined ? `The ${p.name}'s wall switch is off.` : 'Its wall switch is off.'),
  claim_battery_low: (p: { name: string; pct: number }) => `The ${p.name}'s battery is down to ${p.pct}%.`,
  claim_no_blink: (p: { name: string }) => `The ${p.name} didn't respond when I tested it.`,
  claim_worked_now: (p: { name: string }) => `The ${p.name} worked when I tested it just now.`,
  claim_answered_now: (p: { name: string }) => `The ${p.name} answered when I switched it just now.`,
  claim_infra_fine: (_: None) => 'Your hub and its signal look fine.',
  claim_flaps: (p: { name: string; count: number }) => `The ${p.name} dropped off ${p.count} times in the last day.`,
  claim_weak_wifi: (p: { dbm: number }) => `Its Wi-Fi signal is weak, at ${p.dbm} dBm.`,
  claim_weak_zigbee: (p: { lqi: number }) => `Its signal is weak, with a link quality of ${p.lqi} out of 255.`,
  claim_hub_down: (p: { hub: string }) => `Your ${p.hub} isn't answering.`,
  claim_hub_devices: (p: { count: number }) => `${countCap(p.count)} ${p.count === 1 ? 'device on it is' : 'devices on it are'} offline.`,
  claim_cloud: (p: { brand: string }) => `The ${p.brand} cloud reports a problem right now.`,
  claim_auth: (p: { brand: string }) => `The link to your ${p.brand} account has expired.`,
  claim_power_on: (p: { name: string }) => `The ${p.name} is set to switch on whenever power comes back.`,
  claim_collision: (p: { name: string; count: number }) => `${countCap(p.count)} devices answer to ${p.name}.`,
  claim_collision_online: (p: { count: number }) => (p.count === 2 ? 'Both are online.' : 'All of them are online.'),
  claim_refs_ok: (p: { name: string }) => `Every device ${p.name} uses still exists.`,
  claim_dead_trigger: (p: { name: string }) => `The automation ${p.name} still uses a device that was removed.`,
  claim_wifi_peers: (p: { count: number }) => `${countCap(p.count)} other Wi-Fi devices are offline too.`,
  claim_router_changed: (_: None) => 'Your router changed recently.',

  ex_power_back: (p: { time: string }) => stop(`Power came back at ${p.time}`),
  ex_restarted: (p: { count: number; within: string }) => `${countCap(p.count)} devices restarted within ${p.within}.`,
  ex_no_automation: (_: None) => 'None of your automations fired.',
  // `restarted`: more devices restarted than the fix can set, so the line says how many of them it covers.
  ex_offer_power_fix: (p: { count: number; restarted?: number }) =>
    p.restarted !== undefined && p.restarted > p.count
      ? p.count === 1
        ? `One of the ${numberWord(p.restarted)} can remember its last state. I can set that one. Do it?`
        : `${countCap(p.count)} of the ${numberWord(p.restarted)} can remember their last state. I can set those. Do it?`
      : p.count === 1
        ? 'I can make it remember whether it was on or off. Do it?'
        : 'I can make them remember whether they were on or off. Do it?',
  ex_automation: (p: { automation: string; what: string; time: string }) => stop(`Your automation ${p.automation} switched ${p.what} at ${p.time}`),
  ex_automation_trigger: (p: { trigger: string }) => stop(`It ran because of ${p.trigger}`),
  ex_user: (p: { what: string; time: string }) => stop(`Someone switched ${p.what} from the app at ${p.time}`),
  ex_unexplained: (p: { what: string; time: string }) => `I see ${p.what} turned on at ${p.time}, but nothing in the log says why.`,
  // Fixwright's own writes (a flash test, a repair step, an undo) show up in the log like an app command.
  ex_own_intro: (_: None) => 'That was me.',
  ex_own: (p: { verb: 'switched' | 'changed'; what: string; time: string; purposes: string[] }) => stop(`I ${p.verb} ${p.what} at ${p.time} ${joinAnd(p.purposes)}`),
  ex_own_label: (_: None) => 'Fixwright switched it',
  // The question names a device and power came back in that window, but not on that device.
  ex_not_in_restore: (p: { name: string; count: number; time: string }) =>
    stop(`The ${p.name} wasn't one of the ${numberWord(p.count)} devices that restarted when power came back at ${p.time}`),
  ex_in_restore: (p: { name: string }) => (isPluralName(p.name) ? `The ${p.name} were among them.` : `The ${p.name} was one of them.`),
  ex_cant_tell: (_: None) => "I can't tell what happened. Nothing in the log explains it.",
  ex_settle: (_: None) => 'If it happens again, ask me right away while the log is fresh.',
  ex_fix_label: (p: { count: number }) => (p.count === 1 ? 'Make it remember whether it was on or off' : 'Make them remember whether they were on or off'),
  ex_tl_out: (_: None) => 'Power went out',
  ex_tl_back: (_: None) => 'Power came back',
  ex_tl_no_context: (p: { count: number }) =>
    p.count === 1 ? 'It came back on with no automation or app command' : 'They came back on with no automation or app command',

  ck_intro: (p: { count: number }) => (p.count === 1 ? 'I found one thing.' : `I found ${numberWord(p.count)} things.`),
  ck_healthy: (_: None) => "Your home looks healthy. I didn't find anything that needs fixing.",
  ck_more: (p: { count: number }) => (p.count === 1 ? 'There is one more on the screen.' : `There are ${numberWord(p.count)} more on the screen.`),
  ck_title_duplicate: (p: { count: number; noun: string; name: string }) => `${countCap(p.count)} ${plural(p.noun, p.count)} answer to ${p.name}`,
  ck_title_ghost: (p: { name: string }) => `Old copy of ${p.name} still listed`,
  ck_say_ghost: (p: { name: string }) => `An old copy of ${p.name} is still in your device list.`,
  ck_title_flapping: (p: { name: string; count: number; wifi: boolean; period: string }) =>
    `${sentenceCase(p.name)} dropped off${p.wifi ? ' Wi-Fi' : ''} ${p.count} times ${p.period}`,
  ck_say_flapping: (p: { name: string; count: number; wifi: boolean; period: string }) =>
    `the ${lowerName(p.name)} dropped off${p.wifi ? ' Wi-Fi' : ''} ${p.count} times ${p.period}.`,
  ck_title_battery: (p: { name: string; pct: number }) => `${sentenceCase(p.name)} battery at ${p.pct}%`,
  ck_say_battery: (p: { name: string; pct: number }) => `the ${lowerName(p.name)} battery is at ${p.pct}%.`,
  ck_title_dead_trigger: (p: { name: string }) => `${p.name} uses a removed device`,
  ck_title_power_on: (p: { count: number; name: string }) =>
    p.count === 1 ? `${sentenceCase(p.name)} turns on after a power cut` : `${countCap(p.count)} devices turn on after a power cut`,
  ck_title_integration: (p: { brand: string; auth: boolean }) =>
    p.auth ? `${p.brand} needs you to sign in again` : `${p.brand} connection isn't working`,
  ck_title_unprotected: (p: { load: string }) => `${sentenceCase(p.load)} is not protected`,

  pl_intro: (_: None) => "Here's the fix.",
  pl_confirm: (_: None) => 'Shall I go ahead?',
  pl_stale_point: (p: { name: string; noun: string }) => `${p.name} will point to the ${p.noun} that is online.`,
  pl_stale_retire: (p: { since: string }) => `The old copy, offline ${p.since}, is retired.`,
  pl_stale_retire_plain: (_: None) => 'The old copy is retired.',
  pl_stale_aliases: (p: { noun: string; aliases: string[] }) => `The ${p.noun} that is online will also answer to ${joinAnd(p.aliases)}.`,
  pl_power_on: (p: { count: number; name: string }) =>
    p.count === 1
      ? `The ${p.name} will remember whether it was on or off when power comes back.`
      : `${countCap(p.count)} devices will remember whether they were on or off when power comes back.`,
  pl_cant_change: (p: { names: string[] }) => `I can't change the ${joinAnd(p.names)} from here.`,
  pl_rename: (p: { from: string; to: string; name: string }) => `The ${p.from} will be called ${p.to}, so ${p.name} means one device.`,
  pl_reload: (p: { hub: string }) => `I'll reconnect your ${p.hub}. Nothing else changes.`,
  pl_dead_trigger: (p: { name: string }) => `${p.name} will be turned off until you point it at a new device.`,
  pl_protected: (p: { load: string }) => `I won't switch the ${p.load} off, because you marked it protected.`,
  pl_unsafe: (p: { name: string }) => `I'll leave the ${p.name} alone.`,

  st_rename_online: (p: { noun: string; name: string }) => `Give the online ${p.noun} the name ${p.name}`,
  st_aliases: (p: { noun: string; aliases: string[] }) => `Let the online ${p.noun} answer to ${joinAnd(p.aliases)} too`,
  st_retire: (_: None) => 'Retire the old copy',
  st_check: (_: None) => 'Switch it on and off to check it answers',
  st_power_on: (p: { name: string }) => `Set ${p.name} to remember its last state`,
  st_rename: (p: { from: string; to: string }) => `Rename ${p.from} to ${p.to}`,
  st_reload: (p: { hub: string }) => `Reconnect the ${p.hub}`,
  st_automation_off: (p: { name: string }) => `Turn off the automation ${p.name}`,

  rb_name: (p: { name: string }) => `Name reads ${p.name}`,
  rb_retired: (_: None) => 'Old copy is retired',
  rb_restored: (_: None) => 'Old copy is back in the device list',
  rb_answers: (p: { times: number }) => (p.times === 2 ? 'It answered both times' : `It answered all ${numberWord(p.times)} times`),
  rb_option: (p: { option: string }) => `Set to ${p.option}`,
  rb_loaded: (_: None) => 'Connected again',
  rb_state: (p: { state: string }) => `It is ${p.state}`,
  rb_removed: (_: None) => 'Gone from the device list',
  rb_aliases: (p: { aliases: string[] }) => `Also answers to ${joinAnd(p.aliases)}`,
  rb_aliases_back: (_: None) => 'Names are as they were',

  inv_name: (p: { name: string }) => `Give it its old name back, ${p.name}`,
  inv_retire: (_: None) => 'Bring back the old copy',
  inv_aliases: (p: { noun: string }) => `Take the old names off the online ${p.noun}`,
  inv_option: (p: { name: string; option: string }) => `Set ${p.name} back to ${p.option}`,
  inv_automation_on: (p: { name: string }) => `Turn the automation ${p.name} back on`,

  ap_done_flash: (_: None) => 'Done. I switched it on and off, it answered both times.',
  ap_done: (p: { count: number }) =>
    p.count === 1 ? 'Done. I made the change and checked it.' : `Done. I made ${numberWord(p.count)} changes and checked each one.`,
  ap_next_check: (p: { count: number; today?: boolean }) =>
    `I'll check on ${p.count === 1 ? 'it' : 'them'} again ${p.today ? 'at 7 this morning' : 'tomorrow morning'}.`,
  ap_rolled_back: (_: None) => "Something didn't check out, so I put everything back the way it was.",
  ap_failed: (_: None) => "I couldn't finish the fix, and one step needs a look on the screen.",
  undo_done: (p: { name: string }) => `Undone. ${p.name} is back the way it was before the fix.`,
  undo_settings: (p: { count: number }) =>
    p.count === 1
      ? 'Undone. That power on setting is back the way it was.'
      : `Undone. Those ${numberWord(p.count)} power on settings are back the way they were.`,
  undo_nothing: (_: None) => "There's nothing to undo. That fix didn't change any settings.",
  undo_partial: (_: None) => 'I undid what I could. One step needs a look on the screen.',
  mc_pass: (p: { name: string; count: number }) => `${sentenceCase(p.name)} answered ${allCommands(p.count)} overnight. Repair confirmed.`,
  mc_pass_quiet: (p: { name: string }) => `${sentenceCase(p.name)} stayed online all night. Repair confirmed.`,
  mc_fail: (p: { name: string; missed: number; count: number }) =>
    `${sentenceCase(p.name)} missed ${p.missed >= p.count ? allCommands(p.count) : `${p.missed} of ${p.count} commands`} overnight. I'll take another look.`,
  mc_offline: (p: { name: string }) => `${sentenceCase(p.name)} went offline overnight. I'll take another look.`,
  // Every command answered, but it dropped off in between: say both, never "missed 0 of 9".
  mc_answered_offline: (p: { name: string; count: number; drops: number }) =>
    `${sentenceCase(p.name)} answered ${allCommands(p.count)} overnight, but went offline ${timesWord(p.drops)}. I'll take another look.`,
  mc_fail_offline: (p: { name: string; missed: number; count: number; drops: number }) =>
    `${sentenceCase(p.name)} missed ${p.missed >= p.count ? allCommands(p.count) : `${p.missed} of ${p.count} commands`} and went offline ${timesWord(p.drops)} overnight. I'll take another look.`,
  mc_setting_pass: (p: { count: number }) =>
    p.count === 1 ? 'The power on setting held overnight. Repair confirmed.' : 'The power on settings held overnight. Repair confirmed.',
  mc_setting_fail: (p: { changed: number; count: number }) =>
    `${
      p.count === 1
        ? 'The power on setting'
        : p.changed === p.count
          ? `All ${numberWord(p.count)} power on settings`
          : `${countCap(p.changed)} of the ${numberWord(p.count)} power on settings`
    } changed back overnight. I'll take another look.`,
  mc_not_checked: (_: None) => 'This fix has nothing a sensor can check.',

  gc_back: (p: { name: string }) => `The ${p.name} is back online.`,
  gc_back_all: (p: { count: number }) => `All ${numberWord(p.count)} devices are back online.`,
  gc_not_back: (p: { name: string }) => `The ${p.name} still hasn't come back. Ask me about it again when you're next to it.`,
  gc_not_back_some: (p: { missing: number; count: number }) =>
    `${countCap(p.missing)} of the ${numberWord(p.count)} devices still ${p.missing === 1 ? "hasn't" : "haven't"} come back. Ask me again when you're next to ${
      p.missing === 1 ? 'it' : 'them'
    }.`,
  gc_flaps_none: (p: { name: string; period: string; baseline: number }) =>
    p.baseline > 0
      ? `The ${p.name} stayed connected ${p.period}, after dropping off ${p.baseline} ${p.baseline === 1 ? 'time' : 'times'} the day before.`
      : `The ${p.name} stayed connected ${p.period}.`,
  gc_flaps_some: (p: { name: string; count: number; period: string }) =>
    `The ${p.name} dropped off ${p.count} ${p.count === 1 ? 'time' : 'times'} ${p.period}. A plugged in repeater near it should help.`,
  gc_cloud_back: (p: { brand: string; name?: string }) =>
    p.name !== undefined ? `The ${p.brand} cloud is back, and the ${p.name} is online again.` : `The ${p.brand} cloud is back.`,
  gc_cloud_still: (p: { brand: string }) => `The ${p.brand} cloud still reports a problem, so I'll stop checking for now. Ask me any time.`,
  gc_link_back: (p: { brand: string }) => `Your ${p.brand} account is linked again.`,
  gc_link_still: (p: { brand: string }) => `Your ${p.brand} account still needs you to sign in again.`,
  gc_pending: (_: None) => "Not settled yet. I'll check again soon.",

  guard_strip: (p: { loads: string[]; alternativeNoun?: string }) =>
    `That strip runs the ${joinAnd(p.loads.map(lowerName))}, which you marked protected. ${
      p.alternativeNoun !== undefined ? `I'll turn off the ${p.alternativeNoun} on it instead.` : "So I'll leave it on."
    }`,
  guard_protected: (p: { load: string }) => `The ${lowerName(p.load)} is protected, so I'll leave it running.`,
  guard_unsafe: (_: None) => PROBLEM_DEFAULTS.unsafe_device.speech,

  problem: (p: { code: ProblemCode }) => PROBLEM_DEFAULTS[p.code].speech,
} as const;

export type PhraseKey = keyof typeof TEMPLATES;
export type PhraseParams<K extends PhraseKey> = Parameters<(typeof TEMPLATES)[K]>[0];

export const PHRASE_KEYS = Object.keys(TEMPLATES) as PhraseKey[];

/** "Switch plug 3 back on", not "Switch the plug 3 back on": templates say "the {name}", which a numbered name drops. */
function dropArticle(text: string, name: string): string {
  return text.split(`the ${name}`).join(name).split(`The ${name}`).join(capitalize(name));
}

/** The template line for a key. Same params, same words. */
export function phrase<K extends PhraseKey>(key: K, params: PhraseParams<K>): string {
  const text = (TEMPLATES[key] as (p: PhraseParams<K>) => string)(params);
  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' && isNumberedName(name) ? dropArticle(text, name) : text;
}
