---
name: ef-editor-gui
description: "Configure the Editframe editor GUI for visual composition editing — timeline, scrubber, canvas, preview controls. Use when the operator asks to set up or use the Editframe editor."
invocation: user
category: fo
concerns: read-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
triggers:
  - "open editframe editor"
  - "set up editor gui"
  - "add timeline controls"
  - "visual editing"
source: https://editframe.com/skills/editor-gui.md
---

<!-- skill-lint-disable SKILL-17 -->

# Editor Toolkit

The Editframe editor toolkit provides visual composition editing controls: timeline, scrubber, canvas, preview, playback, and transformation.

## Quick start

```html
<ef-timegroup id="my-video">
  <ef-video src="/video.mp4"></ef-video>
</ef-timegroup>

<ef-controls target="my-video">
  <ef-toggle-play></ef-toggle-play>
  <ef-scrubber></ef-scrubber>
  <ef-time-display></ef-time-display>
</ef-controls>
```

## Core concepts: target and bridge

Each playback control (`ef-play`, `ef-pause`, `ef-toggle-play`, `ef-toggle-loop`, `ef-volume`, `ef-mute`, `ef-scrubber`, `ef-time-display`) resolves the composition it drives in this order:

1. Its own `target="id-or-selector"` attribute, if set.
2. Walks up through ancestor `ef-controls`, `ef-preview`, and `ef-configuration` elements. An ancestor with its own `target` resolves there. A bare `ef-configuration` ancestor resolves to itself.
3. As a last resort, resolves to the nearest enclosing temporal root.

`ef-controls` is a pure proxy — it renders nothing itself but gives descendant controls a shared `target`.

## Preview and canvas

- **`ef-preview`** — renders a live preview of the composition
- **`ef-canvas`** — interactive canvas with selection state

## Playback and display controls

- **`ef-play`** / **`ef-pause`** / **`ef-toggle-play`** — playback controls
- **`ef-toggle-loop`** — toggle loop mode
- **`ef-volume`** / **`ef-mute`** — audio controls
- **`ef-time-display`** — current time / total time display
- **`ef-scrubber`** — seekable timeline scrubber
- **`ef-fullscreen`** — fullscreen toggle
- **`ef-pip`** — picture-in-picture toggle

## Timeline

- **`ef-timeline`** — timeline container with rows
- **`ef-timeline-row`** — a single track row
- **`ef-timeline-ruler`** — time ruler with markers
- **`ef-composition-thumbnail-strip`** — thumbnail overview of the composition

## Transform and manipulation

- **`ef-transform-handles`** — drag, resize, rotate handles for elements
- **`ef-trim-handles`** — trim start/end of video clips
- **`ef-fit-scale`** — fit or scale the canvas to the viewport

## Overlay system

- **`ef-overlay-layer`** — overlay container
- **`ef-overlay-item`** — individual overlay panel

## Editor shells

- **`ef-workbench`** — full editor layout with panels
- **`ef-tree`** / **`ef-tree-item`** — hierarchy tree of composition elements
- **`ef-hierarchy`** / **`ef-hierarchy-item`** — alternative hierarchy view with selection bridge

## Element reference

| Element                | Purpose                           |
| ---------------------- | --------------------------------- |
| `ef-canvas`            | Interactive composition canvas    |
| `ef-controls`          | Proxy container for shared target |
| `ef-preview`           | Live composition preview          |
| `ef-scrubber`          | Seekable timeline scrubber        |
| `ef-timeline`          | Timeline container                |
| `ef-time-display`      | Time display                      |
| `ef-toggle-play`       | Play/pause toggle                 |
| `ef-transform-handles` | Element transform controls        |
| `ef-trim-handles`      | Video trim controls               |
| `ef-tree`              | Composition hierarchy tree        |
| `ef-workbench`         | Full editor layout                |
