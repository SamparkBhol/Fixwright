# @fixwright/video: what is checked

## Unit tests (`npm run check -w @fixwright/video`, test/pipeline.test.ts, 30 tests)

- [x] script.txt parser: voices, camera regions, beats, scenes, every step kind including `DO hold`,
      `DO replay`, `DO trace-top` and timed camera moves; `||` spoken overrides; `SHOWN` replies are not
      voiced; mistakes fail with the line number.
- [x] The real script.txt parses, the reply voice is not an `af_` voice, and nothing it shows or says names
      a third party brand or uses a long dash.
- [x] Sentence splitting keeps "3 a.m.?" whole; clip ids are stable and change with voice or text.
- [x] Timeline: steps laid end to end from measured clip lengths only, the user line is typed while it plays
      and sent after it, the reply follows the send, the hold comes before the send and the replay starts on
      the reply's second sentence, a click waits for a camera move (timed or not), only the narrator is
      captioned, a missing clip fails loudly.
- [x] Benchmark card values come from a HomeTruth result (right, can't tell, wrong, right when answering),
      a result that does not add up is refused, and the narration quotes only numbers on the card.
- [x] ASS: colour and time formats, balanced wrapping and escaping, captions, the honesty tag, tap rings only
      where the camera sees them, dips, no brand names.
- [x] Audio, the plain MCP client and ffmpeg header parsing.

## Render checks (`verify.ts`, run by `video:compose`, written to out/verify.json)

- [x] Streams: H.264 High yuv420p 1920x1080 30 fps, AAC 48 kHz stereo.
- [x] Duration equals the timeline within 0.1 s and is under 175 s (2:55).
- [x] A full decode with `-xerror` exits 0 with no error lines.
- [x] Every speech window is louder than -32 dB RMS; every gap of 0.4 s or more is below -55 dB.
- [x] The caption band differs from the capture without captions at the middle of sampled narrator lines.
- [x] No third party brand in the speech, captions, labels, or in the text inside the camera frame.
- [x] No Hindi word in the speech, captions, labels, or in the text inside the camera frame.
- [x] The contact sheet exists.

## Record checks (`record.ts`, written to out/record.json)

- [x] Every `REPLY`/`SHOWN` line equals the live server's answer word for word (any mismatch fails).
- [x] No approval sheet is left open after a spoken turn.
- [x] `DO replay` finds a logged house plan moment; the opened trace row shows its structuredContent.
- [x] The terminal's plain client got `protocolVersion` 2025-11-25 from initialize.
- [x] Console errors and page errors are collected; animations first seen past their start are listed.

## Not automated

- Nobody has listened to the audio: this machine has no sound output. Levels and timing are measured, the
  voices are not judged by ear.
- The look of each frame is checked by eye from the contact sheet and extracted frames.
