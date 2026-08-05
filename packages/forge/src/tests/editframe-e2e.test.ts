/*
<MODULE_CONTRACT>
<purpose>End-to-end tests for the editframe profile: scaffold → doctor → invariants.
Verifies that forge create --profile editframe produces a valid project structure,
forge doctor checks prerequisites and invariants, and both React and HTML templates work.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>End-to-end test: scaffold editframe project with React and HTML templates, run doctor, verify invariants.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInvariants } from "../onboarding/invariant-engine.ts";
import { listStackProfiles } from "../profiles/stack-profile.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";

// Mock execSync to prevent real pnpm install commands from running.
// This allows scaffold to proceed past install to first workspace creation.
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(() => Buffer.from("mocked")),
  };
});

// Import after mock is set up
const { runScaffoldProject } = await import("../onboarding/scaffold-project.ts");
const { runDoctor } = await import("../onboarding/doctor.ts");
const { execSync } = await import("node:child_process");

const FORGE_ROOT = join(import.meta.dirname, "..", "..");

const silentLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: silentLogger as never,
    dryRun: false,
    outputFormat: "json",
    forgeRoot: FORGE_ROOT,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "editframe-e2e-"));
  vi.mocked(execSync).mockClear();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// --- Scaffold tests (install mocked, so all files are created) ---

test("scaffold editframe profile creates workspace dirs and files", async () => {
  const result = await runScaffoldProject(
    { argv: [], flags: { profile: "editframe", name: "my-video-project" } },
    makeContext(tempDir),
  );

  expect(result.exitCode).toBe(0);
  const entries = await readdir(tempDir);
  expect(entries).toContain("compositions");
  expect(entries).toContain("packages");
  expect(entries).toContain("services");
  expect(entries).toContain("pnpm-workspace.yaml");
  expect(entries).toContain("turbo.json");
  expect(entries).toContain("package.json");
  expect(entries).toContain(".gitignore");
  expect(entries).toContain(".github");
  expect(entries).toContain("scripts");
  expect(existsSync(join(tempDir, "scripts", "clean.mjs"))).toBe(true);
});

test("scaffold editframe with --template react creates composition.tsx", async () => {
  const result = await runScaffoldProject(
    { argv: [], flags: { profile: "editframe", name: "my-video-project", template: "react" } },
    makeContext(tempDir),
  );

  expect(result.exitCode).toBe(0);
  const compDir = join(tempDir, "compositions", "my-first-video");
  expect(existsSync(compDir)).toBe(true);
  expect(existsSync(join(compDir, "package.json"))).toBe(true);
  expect(existsSync(join(compDir, "composition.tsx"))).toBe(true);
});

test("scaffold editframe with --template html creates index.html", async () => {
  const result = await runScaffoldProject(
    { argv: [], flags: { profile: "editframe", name: "my-video-project", template: "html" } },
    makeContext(tempDir),
  );

  expect(result.exitCode).toBe(0);
  const compDir = join(tempDir, "compositions", "my-first-video");
  expect(existsSync(compDir)).toBe(true);
  expect(existsSync(join(compDir, "package.json"))).toBe(true);
  expect(existsSync(join(compDir, "index.html"))).toBe(true);
  expect(existsSync(join(compDir, "composition.tsx"))).toBe(false);
});

test("scaffold editframe without --template defaults to react (composition.tsx)", async () => {
  const result = await runScaffoldProject(
    { argv: [], flags: { profile: "editframe", name: "my-video-project" } },
    makeContext(tempDir),
  );

  expect(result.exitCode).toBe(0);
  const compDir = join(tempDir, "compositions", "my-first-video");
  expect(existsSync(join(compDir, "composition.tsx"))).toBe(true);
  // index.html is part of the React+Vite template (Vite entry point)
  expect(existsSync(join(compDir, "index.html"))).toBe(true);
});

test("scaffold editframe with unknown template fails with error", async () => {
  const result = await runScaffoldProject(
    {
      argv: [],
      flags: { profile: "editframe", name: "my-video-project", template: "nonexistent" },
    },
    makeContext(tempDir),
  );

  expect(result.exitCode).toBe(1);
  expect(result.data?.errors.some((e: string) => e.includes("Unknown template"))).toBe(true);
});

// --- Doctor prerequisite tests ---

test("doctor checks prerequisites for editframe profile", async () => {
  // Create a minimal forge.yaml pointing to editframe profile
  await writeFile(
    join(tempDir, "forge.yaml"),
    `schema: "forge/config@1"\nproject:\n  name: test-video\n  stack: ["editframe"]\n  packageManager: pnpm\npaths:\n  rfcsDir: docs/rfcs\n  adrsDir: docs/adrs\n  plansDir: docs/plans\n  auditsDir: docs/audits\n  specsDir: docs/specs\n  skillsDir: .agents/skills\n  sessionsDir: docs/sessions\n`,
    "utf8",
  );

  // Create packages/forge/profiles/ so doctor can find the editframe profile
  await mkdir(join(tempDir, "packages", "forge", "profiles"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "profiles", "editframe.yaml"),
    `schema: "forge/stack-profile@1"\nid: editframe\ndisplayName: Editframe Video\ndetect:\n  anyOf: ["editframe.config.*"]\ndomain: video\nworkspace:\n  dirs: ["compositions"]\n  files: []\ninstall: []\nprerequisites:\n  - id: nodejs\n    name: "Node.js 18+"\n    check: "node --version"\n    severity: error\n  - id: ffmpeg\n    name: "FFmpeg"\n    check: "ffmpeg -version"\n    severity: error\n`,
    "utf8",
  );

  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runDoctor(input, makeContext(tempDir));

  const prereqCheck = result.data!.checks.find((c) => c.name === "prerequisites");
  expect(prereqCheck).toBeDefined();
  expect(prereqCheck!.message).toContain("Node.js");
  expect(prereqCheck!.message).toContain("FFmpeg");
});

// --- Invariant engine tests ---

test("invariant engine checks VIDEO-01 filename pattern on .tsx files", async () => {
  const profiles = listStackProfiles(FORGE_ROOT);
  const profile = profiles.find((p) => p.id === "editframe");
  expect(profile).toBeDefined();

  await mkdir(join(tempDir, "compositions", "my-video"), { recursive: true });
  await writeFile(
    join(tempDir, "compositions", "my-video", "composition.tsx"),
    'import { Timegroup } from "@editframe/react";\nexport default function C() { return <Timegroup duration="10s" mode="contain"><Captions src="a.vtt" /></Timegroup>; }',
    "utf8",
  );

  const results = checkInvariants(profile!, tempDir);
  const video01 = results.find((r) => r.invariantId === "VIDEO-01");
  expect(video01).toBeDefined();
  expect(video01!.checked).toBe(true);
  expect(video01!.violations.length).toBe(0);
});

test("invariant engine checks VIDEO-01 filename pattern on .html files", async () => {
  const profiles = listStackProfiles(FORGE_ROOT);
  const profile = profiles.find((p) => p.id === "editframe");
  expect(profile).toBeDefined();

  await mkdir(join(tempDir, "compositions", "my-video"), { recursive: true });
  await writeFile(
    join(tempDir, "compositions", "my-video", "index.html"),
    '<ef-timeline><ef-timegroup duration="10s" mode="contain"><ef-captions src="a.vtt"></ef-captions></ef-timegroup></ef-timeline>',
    "utf8",
  );

  const results = checkInvariants(profile!, tempDir);
  const video01 = results.find((r) => r.invariantId === "VIDEO-01");
  expect(video01).toBeDefined();
  expect(video01!.checked).toBe(true);
  expect(video01!.violations.length).toBe(0);
});

test("invariant engine flags non-kebab-case filenames", async () => {
  const profiles = listStackProfiles(FORGE_ROOT);
  const profile = profiles.find((p) => p.id === "editframe");
  expect(profile).toBeDefined();

  await mkdir(join(tempDir, "compositions", "bad"), { recursive: true });
  await writeFile(
    join(tempDir, "compositions", "bad", "MyVideo.tsx"),
    'import { Timegroup } from "@editframe/react";\nexport default function C() { return <Timegroup duration="10s" mode="contain"><Captions src="a.vtt" /></Timegroup>; }',
    "utf8",
  );

  const results = checkInvariants(profile!, tempDir);
  const video01 = results.find((r) => r.invariantId === "VIDEO-01");
  expect(video01).toBeDefined();
  expect(video01!.violations.length).toBe(1);
  expect(video01!.violations[0].file).toContain("MyVideo.tsx");
});

test("invariant engine checks VIDEO-05 duration pattern on both .tsx and .html", async () => {
  const profiles = listStackProfiles(FORGE_ROOT);
  const profile = profiles.find((p) => p.id === "editframe");
  expect(profile).toBeDefined();

  await mkdir(join(tempDir, "compositions", "test"), { recursive: true });
  await writeFile(
    join(tempDir, "compositions", "test", "video.tsx"),
    '<Timegroup duration="10s" mode="contain"><Captions src="a.vtt" /></Timegroup>',
    "utf8",
  );
  await writeFile(
    join(tempDir, "compositions", "test", "clip.html"),
    '<ef-timegroup duration="abc" mode="contain"><ef-captions src="a.vtt"></ef-captions></ef-timegroup>',
    "utf8",
  );

  const results = checkInvariants(profile!, tempDir);
  const video05 = results.find((r) => r.invariantId === "VIDEO-05");
  expect(video05).toBeDefined();
  expect(video05!.checked).toBe(true);
  const htmlViolation = video05!.violations.find((v) => v.file.endsWith(".html"));
  expect(htmlViolation).toBeDefined();
  expect(htmlViolation!.message).toContain("abc");
  const tsxViolation = video05!.violations.find((v) => v.file.endsWith(".tsx"));
  expect(tsxViolation).toBeUndefined();
});

test("invariant engine checks VIDEO-06 mode pattern on ef-timegroup elements", async () => {
  const profiles = listStackProfiles(FORGE_ROOT);
  const profile = profiles.find((p) => p.id === "editframe");
  expect(profile).toBeDefined();

  await mkdir(join(tempDir, "compositions", "test"), { recursive: true });
  await writeFile(
    join(tempDir, "compositions", "test", "clip.html"),
    '<ef-timegroup mode="invalid" duration="5s"><ef-captions src="a.vtt"></ef-captions></ef-timegroup>',
    "utf8",
  );

  const results = checkInvariants(profile!, tempDir);
  const video06 = results.find((r) => r.invariantId === "VIDEO-06");
  expect(video06).toBeDefined();
  expect(video06!.violations.length).toBe(1);
  expect(video06!.violations[0].message).toContain("invalid");
});
