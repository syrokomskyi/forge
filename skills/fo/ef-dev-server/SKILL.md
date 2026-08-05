---
name: ef-dev-server
description: "Set up and manage the Editframe dev server for live preview and local asset serving. Use when the operator asks to set up or configure the Editframe dev server."
invocation: user
category: fo
concerns: read-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
triggers:
  - "set up editframe dev server"
  - "configure editframe preview"
  - "local asset serving"
  - "dev server not working"
---
<!-- skill-lint-disable SKILL-17 -->

# Dev Server

The Editframe dev server provides JIT video transcoding, local image and caption serving, and a local files API that mirrors the production files API. It integrates with Vite, Next.js, or any framework-agnostic setup.

## Vite setup

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { vitePluginEditframe } from "@editframe/vite-plugin";

export default defineConfig({
  plugins: [
    vitePluginEditframe({
      root: "./src",
      cacheRoot: "./cache",
    }),
  ],
});
```

The plugin mounts onto Vite's own dev server. Compositions make same-origin requests. No separate port and no CORS setup are necessary.

## Next.js setup

```javascript
// next.config.mjs
import { withEditframe } from "@editframe/nextjs-plugin";

export default withEditframe(
  { root: "./src", cacheRoot: "./cache" },
  {
    // your existing Next.js config
  },
);
```

`withEditframe` starts a sidecar HTTP server next to `next dev`, on port 3099 by default. The sidecar does not start in production.

## Framework-agnostic setup

For a toolchain with no Vite or Next.js integration, call `@editframe/dev-server` directly:

```typescript
import { createEditframeDevServer, createProdEfHandlers } from "@editframe/dev-server";
import {
  generateTrack,
  generateScrubTrack,
  generateTrackFragmentIndex,
  cacheImage,
  findOrCreateCaptions,
  md5FilePath,
} from "@editframe/assets";
import { Client, createURLToken } from "@editframe/api";

const server = createEditframeDevServer(
  { root: "./src", cacheRoot: "./cache" },
  { generateTrack, generateScrubTrack, generateTrackFragmentIndex, cacheImage, findOrCreateCaptions, md5FilePath },
  createProdEfHandlers({
    createURLToken,
    getClient: () => new Client(process.env.EF_TOKEN),
  }),
);

server.listen(3001, () => console.log("Editframe dev server running on http://localhost:3001"));
```

## What it enables

- **JIT video transcoding** — reference a local video file directly (`<Video src="clip.mp4" />`). The dev server transcodes it into streamable segments on first request, then serves cached segments.
- **Local image and caption serving** — `<Image>` and caption generation work against local files.
- **A local files API** that mirrors the shape of the production files API.
- **URL signing** — `ef-configuration`'s default `signing-url` forwards to the real Editframe cloud API. Set `EF_TOKEN` before starting the dev server. Set `EF_HOST` to point at a non-default API host.

## Visual regression testing (Vite only)

The Vite plugin supports visual regression testing. Configure snapshot directories and thresholds in the plugin options.

## Debug logging

Set `DEBUG=editframe:*` to enable verbose logging from the dev server and plugin.
