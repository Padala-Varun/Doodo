# Doodo

An AI teacher that **talks while it draws**. Ask a question and Doodo explains it on a whiteboard: it speaks one sentence at a time and draws, writes and points while it speaks. You can also draw, type or drop an image (a question paper, a code screenshot, a photo) and ask about it. Doodo looks at the exact board snapshot and annotates the real objects in it: circles, arrows, callouts, underlines.

- **LLM:** OpenRouter
- **Voice:** Sarvam AI (streaming text-to-speech, plus speech-to-text for push-to-talk)

## Quick start

```bash
npm install
cp .env.example .env      # add OPENROUTER_API_KEY and SARVAM_API_KEY
npm run dev               # http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm test` | unit tests: parser, layout, fonts, expressions, TeX |
| `npm run typecheck` | TypeScript check |
| `npm run build && npm start` | production |
| `npm run smoke:openrouter [model…]` | measure first-token latency of teacher models |
| `npm run smoke:sarvam` | check TTS latency and response shape |

## How it works

```
Browser                                   Next.js route handlers (Node)
────────────────────────────────          ─────────────────────────────────────────────
Board (SVG) + editor tools                POST /api/lesson  (Server-Sent Events)
  │  snapshot PNG + scene summary ───▶      teacher LLM stream (OpenRouter)
  │                                           → streaming DML parser (state machine)
  │                                           → <voice> → Sarvam WebSocket TTS (PCM)
  │                                           → <find>  → vision grounding (box_2d)
  │                                           → <math>  → MathJax → pure-path SVG
  ◀── op / audio / anchor events ─────
LessonPlayer: voice + drawing "beats"
Compiler: ops → strokes, with layout
Animator: pen draws stroke by stroke       POST /api/stt  (push-to-talk → Sarvam)
```

- **DML (Doodo Markup Language).** The model streams flat XML-like tags: `voice`, `write`, `box`, `arrow`, `tri`, `sketch`, `callout`, `math`, `plot`, `table`, `find`, and others. The full spec is in [lib/server/prompts/teacher.ts](lib/server/prompts/teacher.ts).
  - Each tag is parsed and drawn the moment it closes.
  - The parser in [lib/dml/](lib/dml/) is a hand-written character state machine, and value grammars are recursive-descent scanners. There is no regex anywhere.
  - The same op list results no matter how the stream is chunked (property-tested), and malformed tags are skipped, never fatal.
- **Beats.** Each `<voice>` plus the tags after it form a beat. The audio and the drawing of a beat start together. Pen speed adapts so the strokes finish roughly when the sentence ends ([lib/client/player.ts](lib/client/player.ts)).
- **Layout engine** ([lib/board/compile.ts](lib/board/compile.ts)). The model says *what* to draw and roughly *where*, and deterministic geometry does the exact maths:
  - relative placement (`below`, `right-of`, regions)
  - connectors that attach to shape borders and route around obstacles
  - edge labels placed outside shapes
  - callouts placed in free space, with leader arrows
  - collision nudging, so text never lands on text
- **Handwriting.** A single-stroke font: Shadows Into Light centerlines, plus hand-made glyphs for → π √ ≤ ₹ Greek letters, superscripts and accents. Text is literally *written* stroke by stroke, never faded in.
- **Shapes and ink.**
  - rough.js (seeded, so shapes never jitter) for shapes and hachure.
  - perfect-freehand for marker strokes and sketches.
  - Fills and highlights live in a board-wide under-layer, so they never cover ink.
- **Image grounding** ([lib/server/ground.ts](lib/server/ground.ts)).
  1. The teacher declares targets with `<find id desc>`.
  2. The server batches them into a vision call (Gemini-style `box_2d`, 0–1000).
  3. Small objects get a second, zoomed-in crop pass for pixel-tight boxes.
  4. Results stream back as `anchor` events.
  - Anything the user drew or typed is known exactly and exposed as `@u1…` anchors.
- **Voice.** Sarvam `bulbul:v3` over one WebSocket per lesson: about 270 ms to first audio per sentence, raw PCM scheduled gaplessly with WebAudio. It falls back to REST WAV automatically.

## Models

The defaults were chosen from the live OpenRouter catalogue for quality versus price. Override them in `.env` (see `.env.example`).

| Role | Default | Why |
| --- | --- | --- |
| Teacher | `google/gemini-3.7-flash` | ~2.5 s to first sentence, good layout sense, ~$0.006 per lesson |
| Deep mode | `openai/gpt-5.5` | richest sketches and explanations |
| Grounding | `google/gemini-3.8-flash` | strong `box_2d` detection |

Each role has OpenRouter fallbacks, so a provider outage fails over automatically.

## Using it

- **Tools:** select/move (V), pan (H or Space-drag), pen (P), highlighter (M), text (T), rectangle (R), ellipse (O), arrow (A), eraser (E).
- **Images:** add them with the image button, paste, or drag-drop.
- **Undo/redo:** Ctrl+Z / Ctrl+Shift+Z. A whole lesson is a single undo step.
- **During a lesson:** Space pauses and resumes, and Stop interrupts. Asking a new question interrupts too.
- **Settings:** voice on/off, speaker, speed, and Deep mode are in the top bar.
