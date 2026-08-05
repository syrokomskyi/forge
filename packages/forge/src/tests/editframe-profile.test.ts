/*
<MODULE_CONTRACT>
<purpose>Unit tests for the editframe stack profile — verifies domain fields, terminology, artifacts, workspaceTypes, invariants, and detect markers.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0641: initial editframe-html profile tests.</item>
  <item>RFC-0694: update for editframe profile rename and React template.</item>
  <item>Bootstrap fix: regression tests for 7 editframe React template bugs (vite import, plugin options, Configuration/Workbench wrappers, elements/gui+styles imports, @editframe/elements dep, allowBuilds).</item>
</CHANGE_SUMMARY>
*/

import { test, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadStackProfile, stackProfileSchema } from "../profiles/stack-profile.ts";

const FORGE_ROOT = join(import.meta.dirname, "..", "..");
const PROFILE_PATH = join(FORGE_ROOT, "profiles", "editframe.yaml");

test("loadStackProfile succeeds on editframe.yaml", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.id).toBe("editframe");
});

test("stackProfileSchema.safeParse succeeds on editframe profile", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  const result = stackProfileSchema.safeParse(profile);
  expect(result.success).toBe(true);
});

test("editframe profile declares domain: video", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.domain).toBe("video");
});

test("editframe profile declares register: creative", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.register).toBe("creative");
});

test("editframe profile declares terminology map with artifact, module, operator", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.terminology?.artifact).toBe("composition");
  expect(profile.terminology?.module).toBe("scene");
  expect(profile.terminology?.operator).toBe("director");
});

test("editframe profile declares artifacts with composition extensions", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.artifacts).toBeDefined();
  expect(profile.artifacts?.length).toBeGreaterThanOrEqual(1);
  const composition = profile.artifacts?.find((a) => a.id === "composition");
  expect(composition).toBeDefined();
  expect(composition?.extensions).toContain(".tsx");
  expect(composition?.produce?.command).toBe("editframe render");
  expect(composition?.validate?.command).toBe("editframe check");
});

test("editframe profile declares workspaceTypes with composition detection markers", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.workspaceTypes).toBeDefined();
  const compositionType = profile.workspaceTypes?.find((w) => w.id === "composition");
  expect(compositionType).toBeDefined();
  expect(compositionType?.detect.glob).toBe("*.tsx");
  expect(compositionType?.detect.contains).toBe("TimelineRoot");
  expect(compositionType?.detect.packageJsonDep).toBe("@editframe/react");
});

test("editframe profile declares detect.anyOf with editframe.config.*", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.detect.anyOf).toContain("editframe.config.*");
});

test("editframe profile declares at least 3 VIDEO-* invariants", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.invariants).toBeDefined();
  const videoInvariants = profile.invariants?.filter((i) => i.id.startsWith("VIDEO-"));
  expect(videoInvariants?.length).toBeGreaterThanOrEqual(9);
});

test("editframe profile includes workspace layout with compositions/ directory", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.workspace.dirs).toContain("compositions");
});

test("editframe profile includes first workspace template with sample React composition", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.firstWorkspace).toBeDefined();
  expect(profile.firstWorkspace?.path).toBe("compositions/my-first-video");
  const tsxFile = profile.firstWorkspace?.files.find((f) => f.path === "composition.tsx");
  expect(tsxFile).toBeDefined();
  expect(tsxFile?.content).toContain("TimelineRoot");
  expect(tsxFile?.content).toContain("@editframe/react");
});

test("editframe profile includes @warpgogol/forge in install steps", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  const hasForge = profile.install.some((cmd) => cmd.includes("@warpgogol/forge"));
  expect(hasForge).toBe(true);
});

test("editframe profile declares prerequisites for Node.js and FFmpeg", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.prerequisites).toBeDefined();
  expect(profile.prerequisites?.length).toBeGreaterThanOrEqual(2);
  const nodePrereq = profile.prerequisites?.find((p) => p.id === "nodejs");
  expect(nodePrereq).toBeDefined();
  expect(nodePrereq?.check).toBe("node --version");
  expect(nodePrereq?.severity).toBe("error");
  const ffmpegPrereq = profile.prerequisites?.find((p) => p.id === "ffmpeg");
  expect(ffmpegPrereq).toBeDefined();
  expect(ffmpegPrereq?.check).toBe("ffmpeg -version");
  expect(ffmpegPrereq?.severity).toBe("error");
});

test("editframe profile declares templates with react (default) and html", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  expect(profile.templates).toBeDefined();
  expect(profile.templates?.length).toBe(2);
  const reactTemplate = profile.templates?.find((t) => t.id === "react");
  expect(reactTemplate).toBeDefined();
  expect(reactTemplate?.default).toBe(true);
  const reactTsx = reactTemplate?.firstWorkspace.files.find((f) => f.path === "composition.tsx");
  expect(reactTsx).toBeDefined();
  expect(reactTsx?.content).toContain("TimelineRoot");
  const htmlTemplate = profile.templates?.find((t) => t.id === "html");
  expect(htmlTemplate).toBeDefined();
  expect(htmlTemplate?.default).toBeUndefined();
  const htmlFile = htmlTemplate?.firstWorkspace.files.find((f) => f.path === "index.html");
  expect(htmlFile).toBeDefined();
  expect(htmlFile?.content).toContain("ef-timegroup");
});

test("editframe profile declares html-composition workspace type", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  const htmlType = profile.workspaceTypes?.find((w) => w.id === "html-composition");
  expect(htmlType).toBeDefined();
  expect(htmlType?.detect.glob).toBe("*.html");
  expect(htmlType?.detect.contains).toBe("ef-timegroup");
});

test("editframe profile invariants cover both .tsx and .html files", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  const allGlobs = profile.invariants?.map((i) => i.check?.glob) ?? [];
  for (const glob of allGlobs) {
    expect(glob).toContain("{tsx,html}");
  }
});

test("editframe profile artifacts include .html extension", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  const composition = profile.artifacts?.find((a) => a.id === "composition");
  expect(composition?.extensions).toContain(".html");
  expect(composition?.extensions).toContain(".tsx");
});

// --- Bootstrap regression tests (7 bug fixes) ---

function getReactTemplateFiles(profile: ReturnType<typeof loadStackProfile>) {
  const sources = [
    { label: "firstWorkspace", files: profile.firstWorkspace?.files ?? [] },
    {
      label: "templates[react]",
      files: profile.templates?.find((t) => t.id === "react")?.firstWorkspace.files ?? [],
    },
  ];
  return sources;
}

test("bug 1: pnpm-workspace.yaml includes allowBuilds with boolean true values", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  const wsFile = profile.workspace.files.find((f) => f.path === "pnpm-workspace.yaml");
  expect(wsFile).toBeDefined();
  expect(wsFile?.content).toContain("allowBuilds:");
  expect(wsFile?.content).toContain('"@editframe/cli": true');
  expect(wsFile?.content).toContain("node-av: true");
  expect(wsFile?.content).not.toContain("set this to");
});

test("bugs 2,3: vite.config.ts uses named import and passes root+cacheRoot to plugin", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  for (const { label, files } of getReactTemplateFiles(profile)) {
    const viteFile = files.find((f) => f.path === "vite.config.ts");
    expect(viteFile, `${label}: vite.config.ts should exist`).toBeDefined();
    expect(viteFile?.content).toContain("vitePluginEditframe as editframePlugin");
    expect(viteFile?.content).not.toContain('import editframePlugin from "@editframe/vite-plugin"');
    expect(viteFile?.content).toContain("import.meta.dirname");
    expect(viteFile?.content).toContain("cacheRoot");
    expect(viteFile?.content).toContain("editframePlugin({ root, cacheRoot })");
    expect(viteFile?.content).not.toContain("editframePlugin()");
  }
});

test("bug 4: composition.tsx wraps in Configuration + Workbench", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  for (const { label, files } of getReactTemplateFiles(profile)) {
    const tsxFile = files.find((f) => f.path === "composition.tsx");
    expect(tsxFile, `${label}: composition.tsx should exist`).toBeDefined();
    expect(tsxFile?.content).toContain("Configuration");
    expect(tsxFile?.content).toContain("Workbench");
    expect(tsxFile?.content).toContain('resolution="1920x1080"');
  }
});

test("bugs 5,6: src/main.tsx imports @editframe/elements/gui and styles.css", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  for (const { label, files } of getReactTemplateFiles(profile)) {
    const mainFile = files.find((f) => f.path === "src/main.tsx");
    expect(mainFile, `${label}: src/main.tsx should exist`).toBeDefined();
    expect(mainFile?.content).toContain('import "@editframe/elements/gui"');
    expect(mainFile?.content).toContain('import "@editframe/elements/styles.css"');
  }
});

test("bug 7: @editframe/elements in install list for both firstWorkspace and react template", () => {
  const profile = loadStackProfile(PROFILE_PATH);
  const fwInstall = profile.firstWorkspace?.install ?? [];
  const reactInstall =
    profile.templates?.find((t) => t.id === "react")?.firstWorkspace.install ?? [];
  for (const [label, install] of [
    ["firstWorkspace", fwInstall],
    ["templates[react]", reactInstall],
  ] as const) {
    const hasElements = install.some((cmd) => cmd.includes("@editframe/elements"));
    expect(hasElements, `${label}: install should include @editframe/elements`).toBe(true);
  }
});

test("reference template composition.tsx includes Configuration and Workbench", () => {
  const templatePath = join(FORGE_ROOT, "profiles", "editframe-templates", "composition.tsx");
  const content = readFileSync(templatePath, "utf8");
  expect(content).toContain("Configuration");
  expect(content).toContain("Workbench");
});
