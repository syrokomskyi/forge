---
name: extension-e2e-mitm
description: Intercept Chrome-extension tab navigations in Playwright e2e via a local CONNECT MITM proxy — the only reliable seam when page.route cannot see chrome.tabs.create traffic.
invocation: user
category: shared
concerns: code-mutation
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
---

# extension-e2e-mitm

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Use this skill when a Playwright e2e suite must control what a Chrome MV3 extension's tabs load — and `context.route` / `page.route` cannot see the traffic.

## When this applies

- The extension's service worker opens tabs via `chrome.tabs.create` (or `windows.create`).
- Playwright route interception is installed but the fixture HTML never reaches the tab.
- Symptom: `context.on("page")` fires with the real URL already in flight — the navigation started before the page surfaced to Playwright, so no route handler ever runs.

This is a hard platform limitation, not a misconfiguration: extension-spawned navigations bypass the Playwright route layer entirely. Do not retry routing with different scopes (`context.route`, per-page `page.route`, `routeFromHAR`) — none of them see the request. Intercept at the network layer instead.

## The pattern

1. **Local CONNECT proxy** (`fixture-proxy.ts` in this skill's directory — copy it into the project's e2e folder). It listens on `127.0.0.1`, accepts CONNECT only for an allowlist of host suffixes, answers TLS with a per-run self-signed cert, and serves the currently-installed fixture HTML for every request. Non-allowlisted CONNECTs are refused — the proxy never tunnels real traffic.
2. **Browser flags** at `chromium.launchPersistentContext`:
   - `--proxy-server=http://127.0.0.1:<port>` — all browser traffic through the proxy.
   - `--proxy-bypass-list=127.0.0.1;localhost` — the local API/backend must NOT go through the proxy.
   - `--ignore-certificate-errors-spki-list=<spki>` — whitelist ONLY the proxy cert's SPKI fingerprint (exposed as `proxy.spkiFingerprint`). Never use blanket `--ignore-certificate-errors` — it disables TLS verification for the whole browser.
3. **Fixture swap** — `proxy.setContent(html)` changes what every intercepted request returns. Install fixtures per spec, not per suite.

## Integration steps

1. Copy `fixture-proxy.ts` into the project's e2e directory.
2. Pass the site's host suffixes to `startFixtureProxy({ hosts: [...] })` — the cert CN/SAN and the CONNECT allowlist derive from them.
3. Launch the browser with the three flags above (proxy server, bypass list, spki-list).
4. In each spec, `proxy.setContent(fixtureHtml)` before triggering the extension flow; assert on backend state (D1/API), not on page DOM.
5. Close the proxy with the browser context (`context.on("close", () => proxy.close())`).

## Parameters and limits

- `hosts` — suffix list; `host === suffix || host.endsWith("." + suffix)` matches. Keep it tight: only the fixture-served sites.
- The cert is generated per run via `openssl req -x509` into a temp dir — openssl must be on PATH; no secrets touch the repo.
- The CONNECT parser reads the first TCP chunk — sufficient on loopback; do not reuse this proxy for real forwarding.
- Headed browser required for MV3 service workers — wrap CI in `xvfb-run`.

## Anti-patterns

- Do not add runtime hooks to the extension to make it "testable" — the proxy keeps production code untouched.
- Do not copy fixture HTML into the e2e folder — serve the canonical fixtures from their owning package.
- Do not broaden the allowlist to "just make it work" — a refused CONNECT is the signal that a new host needs an explicit decision.
