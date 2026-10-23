// The homefault fault library as the "Break my house" panel shows it. Ids match the
// server's /demo/fault contract; the words are written for a judge clicking through the demo.

export interface FaultInfo {
  code: string;
  id: string;
  title: string;
  detail: string;
  /** A dated public report the scenario is reconstructed from, when there is one. */
  source?: { url: string; date?: string };
}

export const FAULTS: readonly FaultInfo[] = [
  {
    code: 'F1',
    id: 'ghost_after_repair',
    title: 'Lamp paired again leaves a ghost',
    detail: 'The hallway lamp was paired again. Its name still points at the old copy, offline since October 3.',
    source: { url: 'https://www.reddit.com/r/alexa/comments/1wbmeqx/', date: '9 Sep 2026' },
  },
  {
    code: 'F2',
    id: 'power_restore_default_on',
    title: 'Power cut, everything comes back on',
    detail: 'Power drops at 03:11:58 and returns two seconds later. Fourteen plugs and lights wake up on.',
    source: { url: 'https://www.reddit.com/r/alexa/comments/1wo3p68/', date: '23 Sep 2026' },
  },
  { code: 'F3', id: 'duplicate_spoken_name', title: 'Two lights, one name', detail: 'A Hue group and a Zigbee bulb are both called Living Room Light.' },
  { code: 'F4', id: 'wifi_flapping', title: 'Plug keeps dropping off Wi-Fi', detail: 'The kitchen plug loses Wi-Fi again and again on a weak signal.' },
  { code: 'F5', id: 'low_battery', title: 'Sensor battery nearly flat', detail: 'The hall motion sensor battery runs low.' },
  { code: 'F6', id: 'vendor_cloud_outage', title: 'Thermostat cloud outage', detail: "The thermostat vendor's cloud is degraded, so the thermostat goes unavailable." },
  { code: 'F7', id: 'account_link_expired', title: 'Account link expired', detail: 'The Hue integration fails to sign in and needs relinking.' },
  { code: 'F8', id: 'hub_down', title: 'Zigbee hub unreachable', detail: 'The Zigbee coordinator stops answering, so every Zigbee device goes unavailable.' },
  {
    code: 'F9',
    id: 'dead_trigger',
    title: 'Automation points at a removed plug',
    detail: 'The grow light automation still waits on a plug that no longer exists.',
    source: { url: 'https://www.reddit.com/r/alexa/comments/1sw9b83/' },
  },
  {
    code: 'F10',
    id: 'router_ssid_change',
    title: 'New router, plugs offline',
    detail: 'The Wi-Fi router changed, and the Wi-Fi plugs never rejoined.',
    source: { url: 'https://www.reddit.com/r/alexa/comments/1x25meq/', date: '10 Oct 2026' },
  },
];

export const FAULT_IDS: readonly string[] = FAULTS.map((f) => f.id);

/**
 * Safety net drills (apps/server src/household/safety.ts): one shot failures that show the repair loop
 * failing safe. They go to the same /demo/fault route and fire once.
 */
export const DRILLS: readonly FaultInfo[] = [
  {
    code: 'S1',
    id: 'next_step_fails',
    title: "The next fix won't stick",
    detail: "The next repair's first change is accepted but never lands, like a command a device dropped. Fixwright reads it back and puts everything back.",
  },
  {
    code: 'S2',
    id: 'overnight_relapse',
    title: 'The fixed lamp loses power overnight',
    detail: "At 2:00 tonight the repaired lamp's wall switch goes off for 20 minutes. The 7:00 check should catch it and offer a next step.",
  },
];

/** A fault or a drill by id, for labels. */
export const faultInfo = (id: string): FaultInfo | undefined => FAULTS.find((f) => f.id === id) ?? DRILLS.find((f) => f.id === id);
