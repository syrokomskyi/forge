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
- **`Audio`** (`ef-audio`) — audio source
- **`Image`** (`ef-image`) — image source
- **`Text`** (`ef-text`) — text overlay with positioning
- **`Captions`** (`ef-captions`) — accessibility captions for speech audio
- **`Waveform`** (`ef-waveform`) — audio waveform visualization

## Rendering

Run `ref(forge.yaml bindings.commands.build)` to produce the final video output. The output format is MP4 by default. Use `ref(forge.yaml bindings.commands.validate)` to check composition structure before rendering.

## React

Import components from `@editframe/react`. React props use camelCase. The composition is a standard React component that returns JSX.

## Element reference

| Element | React component | Key props |
| --- | --- | --- |
| `ef-timegroup` | `Timegroup` | `duration`, `mode`, `fps`, `offset`, `loop` |
| `ef-video` | `Video` | `src`, `fit`, `duration` |
| `ef-audio` | `Audio` | `src` |
| `ef-text` | `Text` | `text`, `x`, `y`, `fontSize`, `color`, `textAlign`, `duration` |
| `ef-captions` | `Captions` | `src` |
| `ef-image` | `Image` | `src`, `fit`, `duration` |
| `ef-waveform` | `Waveform` | `src`, `color` |
