# Self-host harness (WP-6)

This directory pins the **npm-published** `@warpgogol/forge` — the monorepo's own
governance operations dogfood the exact artifact consumers receive, never the
workspace source. It lives outside the pnpm workspace (`packages/*` glob) so
resolution reaches npm, not the workspace link.

After every forge release: bump the pin in `package.json`, run `pnpm install`
in this directory, verify `node node_modules/@warpgogol/forge/dist/bin/cli.js --version`
prints the new version. The self-host test enforces pin freshness.
