---
name: ef-brand-video-generator
description: "Generate brand video compositions from templates — logo animation, intro/outro, brand colors, typography. Use when the operator asks to generate a brand video."
invocation: user
category: fo
concerns: content-mutation
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
triggers:
  - "generate a brand video"
  - "create a logo animation"
  - "brand intro video"
  - "brand outro video"
---
<!-- skill-lint-disable SKILL-17 -->

# Brand Video Generator

Generate brand video compositions from reusable templates. Brand videos typically include logo animations, intro/outro sequences, brand color overlays, and typography that matches brand guidelines.

## Template structure

A brand video composition uses `@editframe/react` components with brand-specific assets:

```tsx
import { TimelineRoot, Timegroup, Video, Image, Text } from "@editframe/react";

export default function BrandIntro() {
  return (
    <TimelineRoot>
      <Timegroup duration="3s" mode="sequence">
        <Image src="assets/logo.svg" duration="1s" fit="contain" />
        <Text
          text="Your Brand"
          x="50%"
          y="50%"
          fontSize="64px"
          color="#FF6B00"
          duration="1s"
        />
        <Video src="assets/brand-bg.mp4" fit="cover" duration="1s" />
      </Timegroup>
    </TimelineRoot>
  );
}
```

## Brand asset checklist

- **Logo** — SVG or PNG with transparent background
- **Brand colors** — primary, secondary, accent as CSS color values
- **Typography** — brand font family, weights, sizes
- **Background video** — optional branded background clip
- **Audio** — optional brand jingle or voiceover

## Common brand video patterns

### Logo animation

Animate the logo in with a `Timegroup` using `mode="sequence"`:

```tsx
<Timegroup duration="2s" mode="sequence">
  <Image src="assets/logo.svg" duration="0.5s" fit="contain" />
  <Text text="Your Brand" fontSize="48px" color="#FF6B00" duration="1.5s" />
</Timegroup>
```

### Intro/outro pair

Create separate compositions for intro and outro, then combine them in a parent `Timegroup`:

```tsx
<TimelineRoot>
  <Timegroup duration="15s" mode="sequence">
    <BrandIntro />
    <MainContent />
    <BrandOutro />
  </Timegroup>
</TimelineRoot>
```

### Brand color overlay

Use a semi-transparent `Image` or `Text` overlay with brand colors:

```tsx
<Image src="assets/brand-overlay.png" duration="10s" fit="cover" />
```

## Rendering

Run `ref(forge.yaml bindings.commands.build)` to render the brand video. Use `ref(forge.yaml bindings.commands.validate)` to check the composition before rendering.

## Customization

Each brand video template accepts parameters for logo, colors, text, and timing. Adjust the `duration`, `mode`, and asset paths to match the brand guidelines.
