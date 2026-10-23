# @fixwright/video

The demo video: a 2:53 cut of the real product, rendered headless on a CPU with no paid services.
Playwright drives the real host against a live local Fixwright server, Kokoro speaks the narration and the
household user's lines, and ffmpeg-static burns in the captions and labels and writes the MP4.

The steps, in order:

1. `tts.ts` renders every sentence of `script.txt` and measures it (`out/tts/`).
2. `timeline.ts` turns the script and the measured lengths into `out/timeline.json`. The benchmark card's
   numbers are read from `bench/results/hometruth-heldout-b1b2-n100.json` at this step.
3. `record.ts` plays the timeline against the server and captures `out/frames.mp4` and `out/record.json`.
4. `compose.ts` mixes the voices, burns in the overlay, writes `out/fixwright-demo.mp4` and
   `out/contact-sheet.png`, then runs `verify.ts`.

## Run

From the repo root:

```
npm run dev:up                      # once, so apps/views/dist and apps/host/dist are built
npm run video:all -w @fixwright/video
```

`video:all` starts the video's own copy of the stack (`scripts/stack.sh`: server 8733, sandbox 8734, push
receiver 8735, inspectors 8736 and 8737), runs every step and stops the stack. A render never touches the
shared dev stack on 8701/8702. To record against another server, such as the deployed one, set
`FIXWRIGHT_SERVER` (and `FIXWRIGHT_SANDBOX` for its sandbox page).

| script | does |
| --- | --- |
| `video:tts` | Kokoro fp32 on the CPU, one sentence per call, silence trimmed; reuses unchanged clips |
| `video:timeline` | script, measured lengths and benchmark numbers give `out/timeline.json`; fails past `MAX 175` |
| `video:record` | timeline, then the director (needs a running server) |
| `video:compose` | mix, overlay, final encode, contact sheet, then `verify.ts` |
| `video:verify` | the checks alone |
| `video:all` | all of it, with the private stack |

Options: `node record.ts --to 40` captures only the first 40 s; `--from` is for debugging only (compose needs
a capture from 0). Env: `FIXWRIGHT_TTS_THREADS` (default 4), `FIXWRIGHT_TTS_CACHE` (Kokoro model cache,
default `video/.cache`), `FIXWRIGHT_HOMETRUTH` (another HomeTruth result file for the card).

## The script

`script.txt` is plain text, one instruction per line (`NOTE` lines are comments). `USER` lines are typed
into the host and sent; `REPLY` lines are the server's answer, voiced; `SHOWN` answers stay on screen only.
The director compares every `REPLY` and `SHOWN` line with the live answer, and a mismatch fails the render.
Text after `||` is how the voice says it (`3:12` is spoken "three twelve").

`DO hold` keeps the next house plan moment at the house as it was, and `DO replay 2 2.6` plays it from its
logged events starting with the second sentence of the line before, so the hallway lamp blinks in the plan
while the voice says "I'll flash the hallway lamp twice." `CAMERA region 4` moves the camera over 4 s
instead of 0.7 s. `DO trace-top` scrolls the Visual Trace to its first message.

## Rules the cut follows

- No third party brand in the pictures or the speech, and no other people's words on screen: the cut opens
  on our own sentence about the problem, the demo house describes its bulb maker instead of naming it (so
  the live reply says "the light maker's cloud"), and the slate says "a real open source home hub". The
  written description keeps the quotes and their sources.
- English only on screen and in speech.
- Alexa+ is the sponsor's track name and stays. No Alexa logo, no device photo, and no imitation of Alexa's
  voice: the reply voice is `bm_george`, a British male Kokoro voice. A standing tag on every host shot
  says "Alexa+ host simulated. Voices: open source text to speech, not Alexa", and a label marks the
  simulated clock and the local push receiver.
- Every number on the benchmark card comes from the result file; the narration quotes only numbers that are
  on the card (a unit test checks this). The card shows right, can't tell and wrong for all 100 scenarios,
  and says that on right answers alone the three agents cannot be told apart at this sample size.
- The terminal beat runs `node video/src/plain-mcp.ts <server>/mcp` for real (plain fetch, no SDK) against a
  fresh household on the same server and types out its real output. Its structuredContent line is labeled
  as 4 of 10 fields.

## How the capture stays deterministic

- Playwright's fake clock is installed and paused; each frame advances it by exactly 1/30 s.
  `performance.now` stays real, so the latencies and trace times on screen are measured ones.
- CSS animations sit on a frozen document timeline (CDP `Animation.setPlaybackRate 0`) and are seeked per
  frame through the Web Animations API in every frame of the page (host, sandbox proxy, view).
- A live MCP call runs with video time stopped: the director steps the fake clock in 16 ms slices until the
  host reports idle. The answer then appears at the action's time, whatever the network took.
- The camera is a CDP clip with a scale, so zooms rerasterise sharp text instead of upscaling pixels.
- Cards (`cards/cards.html`: the opening, title, benchmark, terminal and slate) are a pure function of
  video time, drawn in the host stage's color tokens and Atkinson Hyperlegible.

## Checks

`verify.ts` (run by compose) checks the streams, the duration (under 175 s), a clean full decode, loudness
in every speech window and silence between them, the burned in caption band, and two screen checks that
`record.ts` feeds: every 10 frames it reads the text inside the camera frame, across the page and its
frames, and fails on any third party brand or Hindi word. Results land in `out/verify.json`.

## Test

```
npm run check -w @fixwright/video     # tsc + vitest
```

## Versions

playwright 1.63.0 (Chromium headless shell), kokoro-js 1.2.1 with model onnx-community/Kokoro-82M-v1.0-ONNX
fp32, ffmpeg-static 5.3.0 (ffmpeg 7.0.2, libx264, libass 0.17.3), Atkinson Hyperlegible Next and Mono
(SIL OFL 1.1, TTF copies of the host's font files in `fonts/`, licenses in `licenses/`).
@huggingface/transformers 3.8.1 is pinned because tts.ts sets the ONNX thread count through it.
See `docs/DEPENDENCIES.md` for the full list.
