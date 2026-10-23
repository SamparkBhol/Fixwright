// The clock every visual reads. It follows the real time by default; the test hook and the video
// pipeline can pin it, and the server's house clock (SimHome time) moves it.
//
// Two kinds of server time reach it. A reading (GET /demo/state) only aligns the clock with the house:
// it never replaces an explicit pin, because the test hook or the video pipeline asked for that time.
// A move (a /demo/clock jump, a reset, a new household) means the house clock itself changed, so a pinned
// clock moves with it. Either way an answer that was asked for before a later pin is too old to apply.

export interface HouseTime {
  /** The house clock itself changed (a jump or a reset), so a pinned clock moves with it. */
  moved?: boolean;
  /** From mark(), taken before the request: a pin made after it wins over this late answer. */
  stamp?: number;
}

export interface HostClock {
  nowMs(): number;
  /** Pin the clock to a fixed time (ISO or ms), or pass null to follow real time again. */
  pin(time: string | number | null): void;
  /** Take the server's house time (see HouseTime). Returns false when it was not applied. */
  syncTo(serverIso: string, opts?: HouseTime): boolean;
  /** A stamp to take before asking the server for its time, for syncTo. */
  mark(): number;
  readonly pinned: boolean;
}

export function createClock(realNow: () => number = () => Date.now()): HostClock {
  let pinned: number | null = null;
  let offset = 0;
  // Counts explicit pins (and unpins): the newest explicit choice beats any answer asked for before it.
  let pins = 0;
  return {
    nowMs: () => (pinned ?? realNow() + offset),
    pin(time) {
      if (time === null) {
        pinned = null;
        pins++;
        return;
      }
      const ms = typeof time === 'number' ? time : Date.parse(time);
      if (!Number.isFinite(ms)) return;
      pinned = ms;
      pins++;
    },
    syncTo(serverIso, opts = {}) {
      const ms = Date.parse(serverIso);
      if (!Number.isFinite(ms)) return false;
      if (opts.stamp !== undefined && opts.stamp !== pins) return false;
      if (pinned !== null) {
        if (!opts.moved) return false;
        pinned = ms;
      } else {
        offset = ms - realNow();
      }
      return true;
    },
    mark: () => pins,
    get pinned() {
      return pinned !== null;
    },
  };
}

export function formatClock(ms: number, timeZone: string): { time: string; date: string } {
  const d = new Date(ms);
  return {
    time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone }),
    date: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone }),
  };
}
