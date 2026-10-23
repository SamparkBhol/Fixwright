// Voice in and out. Replies are spoken with the browser's speechSynthesis in a generic system voice
// (never an imitation of Alexa's voice); the mic uses the Web Speech API where the browser has it.
// Both degrade quietly: no voices or no recognition means text only, never a console error. Speaking
// time is tracked either way (real end events, or an estimate at 2.5 words per second) so the light
// ring and captions behave the same in headless runs.

export interface Speaker {
  speak(text: string): void;
  cancel(): void;
  readonly available: boolean;
}

export interface SpeakerEvents {
  onStart(text: string, estimateMs: number): void;
  onEnd(): void;
}

export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1200, Math.round((words / 2.5) * 1000));
}

export function createSpeaker(events: SpeakerEvents, opts: { muted: boolean }): Speaker {
  const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const pickVoice = (): SpeechSynthesisVoice | null => {
    const voices = synth?.getVoices() ?? [];
    return voices.find((v) => v.lang.startsWith('en') && v.localService) ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
  };

  const finish = (gen: number): void => {
    if (gen !== generation) return;
    if (timer) clearTimeout(timer);
    timer = null;
    events.onEnd();
  };

  return {
    get available() {
      return !opts.muted && !!synth && (synth.getVoices().length ?? 0) > 0;
    },
    speak(text) {
      const gen = ++generation;
      if (timer) clearTimeout(timer);
      const estimate = estimateSpeechMs(text);
      events.onStart(text, estimate);
      const voice = opts.muted ? null : pickVoice();
      if (synth && voice) {
        try {
          synth.cancel();
          const u = new SpeechSynthesisUtterance(text);
          u.voice = voice;
          u.rate = 1;
          u.onend = () => finish(gen);
          u.onerror = () => finish(gen);
          synth.speak(u);
          timer = setTimeout(() => finish(gen), estimate * 2 + 2000);
          return;
        } catch {
          /* fall through to the timer */
        }
      }
      timer = setTimeout(() => finish(gen), estimate);
    },
    cancel() {
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        synth?.cancel();
      } catch {
        /* nothing to cancel */
      }
      events.onEnd();
    },
  };
}

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => RecognitionLike;

export interface Listener {
  readonly supported: boolean;
  start(): void;
  stop(): void;
}

export interface ListenerEvents {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onState(listening: boolean): void;
  onError(message: string): void;
}

export function createListener(events: ListenerEvents): Listener {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  let rec: RecognitionLike | null = null;
  return {
    supported: !!Ctor,
    start() {
      if (!Ctor || rec) return;
      rec = new Ctor();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const text = r?.[0]?.transcript ?? '';
          if (r?.isFinal) events.onFinal(text.trim());
          else interim += text;
        }
        if (interim) events.onInterim(interim.trim());
      };
      rec.onerror = (e) => events.onError(e.error === 'not-allowed' ? 'The microphone is blocked. Type instead.' : "I didn't catch that. Try again or type.");
      rec.onend = () => {
        rec = null;
        events.onState(false);
      };
      try {
        rec.start();
        events.onState(true);
      } catch {
        rec = null;
        events.onState(false);
      }
    },
    stop() {
      rec?.stop();
    },
  };
}
