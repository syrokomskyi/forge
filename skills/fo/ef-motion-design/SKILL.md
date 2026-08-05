---
name: ef-motion-design
description: "Apply motion design patterns to Editframe compositions — transitions, animations, easing, kinetic typography. Use when the operator asks to add motion design or animation patterns."
invocation: user
category: fo
concerns: read-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
triggers:
  - "add motion design"
  - "animate text"
  - "kinetic typography"
  - "transition between scenes"
source: domain-knowledge
---

<!-- skill-lint-disable SKILL-17 -->

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

# Motion Design

Motion design patterns for Editframe compositions: transitions, animations, easing, and kinetic typography. These patterns enhance video compositions with professional motion graphics.

## Transitions

Use `ef-transition` or the `transition` prop to declare CSS-like transitions between scenes:

```tsx
<Timegroup mode="sequence">
  <Video src="assets/scene1.mp4" duration="5s" transition="fade" />
  <Video src="assets/scene2.mp4" duration="5s" transition="slide-left" />
</Timegroup>
```

### Transition types

- **`fade`** — cross-fade between elements
- **`slide-left`** / **`slide-right`** — slide in from left/right
- **`slide-up`** / **`slide-down`** — slide in from top/bottom
- **`zoom-in`** / **`zoom-out`** — scale transition
- **`wipe`** — directional wipe

## Kinetic typography

Animate text with `ef-text` or the `Text` component using timing and positioning:

```tsx
<Timegroup mode="sequence">
  <Text text="First" x="50%" y="50%" fontSize="72px" duration="1s" />
  <Text text="Second" x="50%" y="50%" fontSize="72px" duration="1s" />
  <Text text="Third" x="50%" y="50%" fontSize="72px" duration="1s" />
</Timegroup>
```

### Text animation patterns

- **Sequential reveal** — words appear one after another in a `mode="sequence"` Timegroup
- **Position animation** — animate `x`/`y` props across time
- **Scale animation** — animate `fontSize` across time
- **Color transitions** — animate `color` across time

## Easing

Editframe supports CSS easing functions for transitions and animations:

- `ease` (default)
- `ease-in`
- `ease-out`
- `ease-in-out`
- `linear`
- `cubic-bezier(x1, y1, x2, y2)` — custom bezier curve

## Pan and zoom

Use `ef-pan-zoom` or the `PanZoom` component for Ken Burns-style effects:

```tsx
<PanZoom
  src="assets/photo.jpg"
  duration="5s"
  startX="0%"
  startY="0%"
  endX="100%"
  endY="100%"
  startScale="1"
  endScale="1.5"
/>
```

## Motion blur

Apply motion blur to moving elements with `ef-motionblur` or the `MotionBlur` component:

```tsx
<MotionBlur intensity="0.5">
  <Video src="assets/fast-pan.mp4" duration="3s" />
</MotionBlur>
```

## CSS variables for time-based animation

Editframe compositions support CSS custom properties for time-based values, enabling complex animation sequences without JavaScript:

```css
:root {
  --scene-duration: 5s;
  --transition-duration: 0.5s;
}
```

## Best practices

- Keep transitions consistent within a composition — use 1-2 transition types
- Match transition duration to content pacing (fast cuts for energy, slow for drama)
- Use kinetic typography sparingly — it draws attention
- Preview with `ref(forge.yaml bindings.commands.devServer)` before rendering
- Run `ref(forge.yaml bindings.commands.validate)` to check composition structure
