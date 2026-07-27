# HTML Report Format

The architectural review is rendered as a single self-contained HTML file in `docs/reviews/architecture/<kebab-case-module-path>/arch-[YYYY-MM-DD-HH].html` under the repository root. Tailwind and Mermaid both come from CDNs. Mermaid handles graph-shaped diagrams reliably; hand-built divs and inline SVG handle the more editorial visuals (mass diagrams, cross-sections). Mix the two — don't lean on Mermaid for everything, it'll start to look generic.

## Scaffold

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review — {{repo name}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
    </script>
    <style>
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; }
      .deep { background: linear-gradient(135deg, #0f172a, #1e293b); }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

## Header

Repo name, date, and a compact legend: solid box = module, dashed line = seam, red arrow = leakage, thick dark box = deep module. No introduction paragraph — straight into the candidates.

## Candidate card

Each candidate is one `<article>`:

- **Title** — short, names the deepening (e.g. "Collapse the Order intake pipeline").
- **Badge row** — recommendation strength (`Strong` = emerald, `Worth exploring` = amber, `Speculative` = slate), plus a tag for the dependency category (`in-process`, `local-substitutable`, `ports & adapters`, `mock`).
- **Files** — monospaced list, `font-mono text-sm`.
- **Before / After diagram** — the centrepiece. Two columns, side by side.
- **Problem** — one sentence. What hurts.
- **Solution** — one sentence. What changes.
- **Wins** — bullets, ≤6 words each.
- **ADR callout** (if applicable) — one line in an amber-tinted box.

No paragraphs of explanation. If the diagram needs a paragraph to be understood, redraw the diagram.

## Diagram patterns

### Mermaid graph (dependencies / call flow)

```html
<div class="rounded-lg border border-slate-200 bg-white p-4">
  <pre class="mermaid">
    flowchart LR
      A[OrderHandler] --> B[OrderValidator]
      B --> C[OrderRepo]
      C -.leak.-> D[PricingClient]
      classDef leak stroke:#dc2626,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

### Hand-built boxes-and-arrows

Modules as `<div>`s with borders and labels. Arrows as inline SVG. Use when Mermaid's layout fights you.

### Cross-section (layered shallowness)

Stack horizontal bands to show layers. Before: 6 thin layers. After: 1 thick band.

### Mass diagram (interface vs implementation)

Two rectangles per module. Before: interface nearly as tall as implementation (shallow). After: interface short, implementation tall (deep).

### Call-graph collapse

Before: tree of calls as nested boxes. After: same tree collapsed into one box, internal calls faded.

## Style guidance

- Lean editorial, not corporate-dashboard. Generous whitespace.
- Colour sparingly: one accent plus red for leakage and amber for warnings.
- Keep diagrams ~320px tall for side-by-side viewing.
- Use `text-xs uppercase tracking-wider` for module labels.
- Only scripts: Tailwind CDN and Mermaid ESM import.

## Top recommendation section

One larger card. Candidate name, one sentence on why, anchor link to its card.

## Tone

Use exactly: module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality.

Never substitute: component, service, unit (for module) · API, signature (for interface) · boundary (for seam) · layer, wrapper (for module).

Wins bullets name the gain in glossary terms: "locality: bugs concentrate in one module", "leverage: one interface, N call sites". Don't write "easier to maintain" or "cleaner code".
