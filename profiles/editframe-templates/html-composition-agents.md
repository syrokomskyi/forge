# HTML Composition Workspace

This workspace contains an Editframe video composition using HTML web components.

## Domain terminology

- **Composition** — the artifact this workspace produces (an `.html` file using Editframe web components).
- **Scene** — a structural module within a composition (an `ef-timegroup` block).
- **Director** — the operator who creates and renders the composition.

## Quality invariants

| ID | Description | Severity |
| --- | --- | --- |
| VIDEO-01 | Composition filenames must use kebab-case (lowercase letters, digits, hyphens only). | error |
| VIDEO-02 | Scene durations must use `contain` fit mode by default to avoid unexpected cropping. Use `cover` or `fill` only when intentionally overriding. | warning |
| VIDEO-03 | All speech audio elements (`ef-audio` with speech content) must have corresponding `ef-captions` components for accessibility. | error |

Additional time model invariants (VIDEO-04 through VIDEO-09) may be available. Run `forge doctor` to check the full invariant set enforced by the active profile.

## Time model concepts

Editframe HTML compositions use a time model based on web components:

- **`ef-timeline`** — the root container for the composition.
- **`ef-timegroup`** — a container that groups scenes and controls timing. The root ef-timegroup defines the composition's total duration.
- **`mode`** — timing behavior for children: `sequence` (play one after another), `fixed` (play at absolute offset), `contain` (fit within parent duration), `fit` (scale to fit).
- **`duration`** — CSS time string (e.g. `5s`, `300ms`, `2.5s`) defining how long the element plays.
- **`offset`** — CSS time string defining when the element starts relative to its parent.
- **`fps`** — positive integer defining frames per second (e.g. `30`, `60`).
- **`loop`** — boolean, only on the root ef-timegroup. Nested ef-timegroups should not loop.

## Workflow

1. Create an `.html` file with Editframe web components (`ef-timeline`, `ef-timegroup`, `ef-video`, `ef-audio`, `ef-text`, `ef-captions`).
2. Run `editframe preview` to preview the composition in the browser.
3. Run `ef-composition-review` to review the composition for time model correctness, accessibility, and best practices.
4. Run `editframe check` to validate the composition structure.
5. Run `editframe render -o dist/<name>.mp4` to produce the final video output.
6. Run `ef-render-verify` to verify the render — validation, build, determinism, output inspection.

## Skills

- **ef-onboard** — onboard a new project: prerequisites, discovery, scaffold, preview. Trigger: "create a new video project".
- **ef-composition-review** — review a composition for time model correctness, accessibility, and best practices before rendering. Trigger: "review this composition".
- **ef-render-verify** — verify a render: validate, build, check determinism, inspect output. Trigger: "render and verify".
- **ef-composition** — guide creating a new video composition with Editframe HTML components. Trigger: "create a video composition".
- **ef-dev-server** — set up and manage the Editframe dev server for live preview. Trigger: "set up editframe dev server".
- **ef-editor-gui** — configure the Editframe editor GUI for visual composition editing. Trigger: "open editframe editor".
- **ef-webhooks** — configure Editframe webhooks for render status notifications. Trigger: "set up editframe webhooks".
- **ef-brand-video-generator** — generate brand video compositions from templates. Trigger: "generate a brand video".
- **ef-motion-design** — apply motion design patterns to compositions. Trigger: "add motion design".

## External resources

- [Editframe llms.txt](https://editframe.com/llms.txt) — machine-readable index of Editframe domain skills
- [Editframe composition skill](https://editframe.com/skills/composition.md) — full reference for time model, elements, and rendering
- [Editframe getting started](https://editframe.com/getting-started) — step-by-step guide and agent prompt

## File naming

Composition files use kebab-case: `my-video.html`, `product-demo.html`, `intro-clip.html`.
