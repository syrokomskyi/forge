# Composition Workspace

This workspace contains an Editframe video composition.

## Domain terminology

- **Composition** — the artifact this workspace produces (an HTML file using Editframe custom elements).
- **Scene** — a structural module within a composition (an `ef-timegroup` block).
- **Director** — the operator who creates and renders the composition.

## Quality invariants

- **VIDEO-01**: Composition filenames must use kebab-case (lowercase letters, digits, hyphens only). This ensures consistent naming across the project. Severity: error.
- **VIDEO-02**: Scene durations must use `contain` fit mode by default to avoid unexpected cropping of video content. Use `cover` or `fill` only when intentionally overriding the default. Severity: warning.
- **VIDEO-03**: All speech audio elements (`ef-audio` with speech content) must have corresponding `ef-captions` elements for accessibility. Severity: error.

## Workflow

1. Create a `.html` file with Editframe custom elements (`ef-timegroup`, `ef-video`, `ef-audio`, `ef-text`, `ef-captions`).
2. Run `editframe preview` to preview the composition in the browser.
3. Run `editframe check` to validate the composition structure.
4. Run `editframe render -o dist/<name>.mp4` to produce the final video output.

## Reference template

A sample composition template is available at `editframe-html-templates/composition.html` in the forge profiles directory. Copy it to start a new composition:

```sh
cp node_modules/@warpgogol/forge/profiles/editframe-html-templates/composition.html compositions/my-new-video/composition.html
```

## File naming

Composition files use kebab-case: `my-video.html`, `product-demo.html`, `intro-clip.html`.
