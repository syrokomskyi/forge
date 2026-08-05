---
name: ef-composition
description: "Guide creating a video composition with Editframe React components — time model, media elements, rendering. Use when the operator asks to create or build a video composition."
invocation: user
category: fo
concerns: content-mutation
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
triggers:
  - "create a video composition"
  - "build a video with editframe"
  - "create a composition"
  - "add a scene to my video"
source: https://editframe.com/skills/composition.md
---

<!-- skill-lint-disable SKILL-17 -->

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

# Video Composition

Build video scenes with React components from `@editframe/react`, for example `<Timegroup>` and `<Video>`. Both HTML web component syntax (`<ef-timegroup>`) and React syntax (`<Timegroup>`) share the same composition model and rendering pipeline.

Web component attributes use kebab-case (`file-id`, `api-host`). React props use camelCase (`fileId`, `apiHost`). Four attributes break this pattern: `sourcein`, `sourceout`, `trimstart`, `trimend` — same lowercase string in both forms.

## Quick Start

```tsx
import { TimelineRoot, Timegroup, Video, Text, Audio, Captions } from "@editframe/react";

export default function Composition() {
  return (
    <TimelineRoot>
      <Timegroup duration="10s">
        <Video src="assets/background.mp4" fit="contain" duration="10s" />
        <Text text="Hello, Editframe!" x="50%" y="50%" fontSize="48px" color="white" duration="5s" />
        <Audio src="assets/narration.mp3" />
        <Captions src="assets/captions.vtt" />
      </Timegroup>
    </TimelineRoot>
  );
}
```

Run `ref(forge.yaml bindings.commands.devServer)` to preview. Run `ref(forge.yaml bindings.commands.build)` to render.

## Duration units

- `5s` — seconds
- `500ms` — milliseconds
- `2.5s` — fractional seconds

## Core concepts

### Time model

A composition is a tree of `Timegroup` elements. The root `Timegroup` defines the composition's total duration. Child elements inherit timing context from their parent.

### Timegroups and sequencing

- **`mode="sequence"`** — children play one after another
- **`mode="fixed"`** — children play at absolute offsets
- **`mode="contain"`** (default) — children fit within parent duration
- **`mode="fit"`** — children scale to fit

### Transitions

Use `ef-transition` or the `transition` prop to declare CSS-like transitions between scenes.

### Scripting

Compositions support inline scripting via `ef-script` or the `script` prop for dynamic behavior during rendering.

## Media elements

- **`Video`** (`ef-video`) — video source with `fit` mode (`contain`, `cover`, `fill`)
- **`Audio`** (`ef-audio`) — audio source with FFT analysis (`fftSize`, `fftGain`, `fftDecay`)
- **`Image`** (`ef-image`) — image source
- **`Text`** (`ef-text`) — text overlay with positioning. Splits text into `ef-text-segment` children (`split="word"`, `split="char"`, `split="line"`). Set `stagger` to delay each segment's start. Segments render in light DOM with `data-active` attribute and `--ef-index`, `--ef-word-index`, `--ef-stagger-offset`, `--ef-seed` custom properties.
- **`Captions`** (`ef-captions`) — synchronized captions with word-level highlighting. Accepts caption data via `captionsSrc` (URL to JSON), `captionsScript` (inline script id), or `captionsData` (JS property). JSON uses `segments` or `word_segments` shape with `start`/`end` times.
- **`Waveform`** (`ef-waveform`) — visualizes an `ef-audio` or `ef-video` `target`. Modes: `bars`, `line`, `curve`, `bricks`, `pixel`, `wave`, `spikes`, `roundBars`.
- **`Surface`** (`ef-surface`) — mirrors another element's pixels onto its own canvas. Set `target` to a canvas or any `HTMLElement` to reuse a video's decoded frames without re-decoding.
- **`PanZoom`** (`ef-pan-zoom`) — pan and zoom control for video/image elements.
- **`MotionBlur`** (`ef-motionblur`) — motion blur effect.
- **`Configuration`** (`ef-configuration`) — opt-in element for API authentication. Add when deploying against the Editframe API: `apiHost` and `signingUrl` for signed-URL auth on cross-origin media, `imageProxy` for cross-origin image proxying. Skip for compositions using only local files.

## Rendering

**Browser export.** Call `renderTimegroupToVideo(timegroup, options)` from `@editframe/elements` to encode a live `ef-timegroup` to a video file. Uses WebCodecs. Key options: `width`/`height`/`fps`, `from`/`to` (export range in seconds), `videoCodec`/`audioCodec`/`videoBitrate`/`audioBitrate`, `target` (mediabunny output target), `signal` (AbortSignal), `onProgress`.

For in-app export from an interactive preview, use `ef-workbench`'s `exportVideo()` method (see the `ef-editor-gui` skill). For CLI/cloud rendering (`editframe render`), the `window.EF_RENDER` path handles offscreen cloning automatically.

**Custom render data.** A CLI or Playwright host can inject arbitrary JSON into `window.EF_RENDER_DATA` before running the composition. Read it with `getRenderData<T>()` (module-level function) or `useRenderData<T>()` (React hook). Use this to parameterize a render without templating the composition.

Run `ref(forge.yaml bindings.commands.build)` to produce the final video output. Use `ref(forge.yaml bindings.commands.validate)` to check composition structure before rendering.

## React

Import components from `@editframe/react`. React props use camelCase. The composition is a standard React component that returns JSX.

### React Three Fiber

Wrap a `<Timegroup>` child in `<CompositionCanvas>` from `@editframe/react/r3f` to get an R3F `<Canvas>` synced to composition time. Read the clock with `useCompositionTime()` which returns `{ time, duration }` in seconds.

```tsx
<Timegroup mode="fixed" duration="14s">
  <CompositionCanvas shadows>
    <MyScene />
  </CompositionCanvas>
</Timegroup>
```

For 3D in a Web Worker, use `OffscreenCompositionCanvas` with `@react-three/offscreen`.

### Server-side rendering

`@editframe/react/server` and `@editframe/elements/server` export composition components and types only — no custom-element registration, no DOM, canvas, or WebCodecs code. Import safely in Next.js or Remix server code. These server entry points do not include GUI components or hooks — render those on the client with `dynamic(() => import("@editframe/react"), { ssr: false })`.

### Package entry points

| Import | Environment | Contains |
| --- | --- | --- |
| `@editframe/elements` | Browser | All custom elements, canvas/WebCodecs rendering |
| `@editframe/elements/server` | Browser, Node, SSR | Types only, plus `getRenderInfo()` (browser-only at runtime) |
| `@editframe/elements/gui` | Browser | Editor GUI custom elements (timeline, scrubber, handles) |
| `@editframe/elements/styles.css` | Browser | Base + theme styles |
| `@editframe/react` | Browser | React composition + GUI components, hooks |
| `@editframe/react/server` | Browser, Node, SSR | Composition components only, no hooks/GUI |
| `@editframe/react/r3f` | Browser | `CompositionCanvas`, `OffscreenCompositionCanvas`, `useCompositionTime` |

## Element reference

| Element | React component | Key props |
| --- | --- | --- |
| `ef-timegroup` | `Timegroup` | `duration`, `mode`, `fps`, `offset`, `loop` |
| `ef-video` | `Video` | `src`, `fit`, `duration`, `fileId`, `sourcein`, `sourceout`, `trimstart`, `trimend` |
| `ef-audio` | `Audio` | `src`, `duration`, `volume`, `mute`, `loop`, `fftSize`, `fftGain` |
| `ef-text` | `Text` | `text`, `x`, `y`, `fontSize`, `color`, `textAlign`, `duration`, `split`, `stagger` |
| `ef-captions` | `Captions` | `captionsSrc`, `captionsScript`, `target`, `wordStyle`, `duration` |
| `ef-image` | `Image` | `src`, `fit`, `duration`, `fileId` |
| `ef-waveform` | `Waveform` | `target`, `mode`, `color` |
| `ef-surface` | `Surface` | `target` |
| `ef-pan-zoom` | `PanZoom` | `target`, `pan`, `zoom` |
| `ef-configuration` | `Configuration` | `apiHost`, `signingUrl`, `imageProxy` |
| `ef-transition` | `Transition` | `type`, `duration` |
| `ef-script` | `Script` | `src`, `inline` |
