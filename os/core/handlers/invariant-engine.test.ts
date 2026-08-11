/*
<MODULE_CONTRACT>
<purpose>Unit tests for the invariant enforcement engine (RFC-0675).</purpose>
<non-goals>
  <item>Do not test domain-specific invariant logic — all rules are profile-driven.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0675: initial invariant engine unit tests.</item>
  <item>RFC-0691: add html-attribute-pattern check kind tests.</item>
  <item>RFC-0694: replace html-attribute-pattern tests with attribute-pattern (elements array) tests, add JSX syntax test.</item>
  <item>RFC-0808: add link-resolution, frontmatter-required, path-exclusion check kind tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkInvariants } from "../../../src/onboarding/invariant-engine.ts";
import type { StackProfile } from "../../../src/profiles/stack-profile.ts";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forge-invariant-test-"));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const baseProfile: StackProfile = {
  schema: "forge/stack-profile@1",
  id: "test-profile",
  displayName: "Test Profile",
  detect: { anyOf: [] },
  workspace: { dirs: [], files: [] },
  install: [],
  invariants: [],
};

describe("invariant-engine", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it("filename-pattern detects non-kebab-case filenames", () => {
    writeFile(tempDir, "compositions/my-video.html", "<html></html>");
    writeFile(tempDir, "compositions/My Video.html", "<html></html>");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-01",
          rule: "Composition filenames must use kebab-case",
          severity: "error",
          check: {
            kind: "filename-pattern",
            glob: "compositions/**/*.html",
            pattern: "^[a-z0-9-]+\\.html$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].checked).toBe(true);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].invariantId).toBe("VIDEO-01");
    expect(results[0].violations[0].file).toBe("compositions/My Video.html");
  });

  it("file-contains detects missing required elements", () => {
    writeFile(tempDir, "compositions/video1.html", "<html><body>hello</body></html>");
    writeFile(tempDir, "compositions/video2.html", "<html><ef-captions>text</ef-captions></html>");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-03",
          rule: "All speech audio elements must have corresponding ef-captions",
          severity: "error",
          check: {
            kind: "file-contains",
            glob: "compositions/**/*.html",
            pattern: "ef-captions",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].file).toBe("compositions/video1.html");
  });

  it("file-not-contains detects forbidden content", () => {
    writeFile(tempDir, "compositions/good.html", "<html>clean</html>");
    writeFile(tempDir, "compositions/bad.html", "<html><script>eval('evil')</script></html>");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "SEC-01",
          rule: "No inline scripts",
          severity: "error",
          check: {
            kind: "file-not-contains",
            glob: "compositions/**/*.html",
            negatedPattern: "eval\\(",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].file).toBe("compositions/bad.html");
  });

  it("invariants without check field remain advisory", () => {
    writeFile(tempDir, "compositions/My Video.html", "<html></html>");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-01",
          rule: "Composition filenames must use kebab-case",
          severity: "error",
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].checked).toBe(false);
    expect(results[0].violations).toHaveLength(0);
  });

  it("glob matching no files results in no violations", () => {
    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-01",
          rule: "Composition filenames must use kebab-case",
          severity: "error",
          check: {
            kind: "filename-pattern",
            glob: "compositions/**/*.html",
            pattern: "^[a-z0-9-]+\\.html$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].checked).toBe(true);
    expect(results[0].violations).toHaveLength(0);
  });

  it("malformed regex pattern produces a warning violation", () => {
    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-01",
          rule: "Test rule",
          severity: "error",
          check: {
            kind: "filename-pattern",
            glob: "compositions/**/*.html",
            pattern: "[invalid",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].severity).toBe("warning");
    expect(results[0].violations[0].message).toContain("invalid check pattern");
  });

  it("empty invariants array returns empty results", () => {
    const profile: StackProfile = {
      ...baseProfile,
      invariants: [],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(0);
  });

  it("attribute-pattern detects invalid attribute values", () => {
    writeFile(
      tempDir,
      "compositions/video.html",
      '<ef-timegroup duration="5">hello</ef-timegroup>',
    );

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-05",
          rule: "All duration values must be valid CSS time strings",
          severity: "error",
          check: {
            kind: "attribute-pattern",
            glob: "compositions/**/*.html",
            elements: ["ef-timegroup"],
            attribute: "duration",
            pattern: "^\\d+(\\.\\d+)?(s|ms)$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].invariantId).toBe("VIDEO-05");
    expect(results[0].violations[0].file).toBe("compositions/video.html");
    expect(results[0].violations[0].message).toContain("does not match pattern");
  });

  it("attribute-pattern passes valid attribute values", () => {
    writeFile(
      tempDir,
      "compositions/video.html",
      '<ef-timegroup duration="5s">hello</ef-timegroup>',
    );

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-05",
          rule: "All duration values must be valid CSS time strings",
          severity: "error",
          check: {
            kind: "attribute-pattern",
            glob: "compositions/**/*.html",
            elements: ["ef-timegroup"],
            attribute: "duration",
            pattern: "^\\d+(\\.\\d+)?(s|ms)$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(0);
  });

  it("attribute-pattern skips elements without the declared attribute", () => {
    writeFile(
      tempDir,
      "compositions/video.html",
      '<ef-timegroup mode="sequence">hello</ef-timegroup>',
    );

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-05",
          rule: "All duration values must be valid CSS time strings",
          severity: "error",
          check: {
            kind: "attribute-pattern",
            glob: "compositions/**/*.html",
            elements: ["ef-timegroup"],
            attribute: "duration",
            pattern: "^\\d+(\\.\\d+)?(s|ms)$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(0);
  });

  it("attribute-pattern handles multiple elements in one file", () => {
    writeFile(
      tempDir,
      "compositions/video.html",
      '<ef-timegroup duration="5s">hello</ef-timegroup><ef-timegroup duration="3">world</ef-timegroup>',
    );

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-05",
          rule: "All duration values must be valid CSS time strings",
          severity: "error",
          check: {
            kind: "attribute-pattern",
            glob: "compositions/**/*.html",
            elements: ["ef-timegroup"],
            attribute: "duration",
            pattern: "^\\d+(\\.\\d+)?(s|ms)$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].message).toContain("'3'");
  });

  it("attribute-pattern handles single-quoted attribute values", () => {
    writeFile(
      tempDir,
      "compositions/video.html",
      "<ef-timegroup duration='5s'>hello</ef-timegroup>",
    );

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-05",
          rule: "All duration values must be valid CSS time strings",
          severity: "error",
          check: {
            kind: "attribute-pattern",
            glob: "compositions/**/*.html",
            elements: ["ef-timegroup"],
            attribute: "duration",
            pattern: "^\\d+(\\.\\d+)?(s|ms)$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(0);
  });

  it("attribute-pattern with missing elements/attribute produces warning violation", () => {
    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-05",
          rule: "All duration values must be valid CSS time strings",
          severity: "error",
          check: {
            kind: "attribute-pattern" as const,
            glob: "compositions/**/*.html",
            pattern: "^\\d+(\\.\\d+)?(s|ms)$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].severity).toBe("warning");
    expect(results[0].violations[0].message).toContain("without elements or attribute");
  });

  it("attribute-pattern detects JSX syntax with elements array", () => {
    writeFile(tempDir, "compositions/video.tsx", '<Timegroup duration="5s">hello</Timegroup>');

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-05",
          rule: "All duration values must be valid CSS time strings",
          severity: "error",
          check: {
            kind: "attribute-pattern",
            glob: "compositions/**/*.tsx",
            elements: ["ef-timegroup", "Timegroup"],
            attribute: "duration",
            pattern: "^\\d+(\\.\\d+)?(s|ms)$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(0);
  });

  it("attribute-pattern detects invalid JSX attribute values", () => {
    writeFile(tempDir, "compositions/video.tsx", '<Timegroup duration="5">hello</Timegroup>');

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-05",
          rule: "All duration values must be valid CSS time strings",
          severity: "error",
          check: {
            kind: "attribute-pattern",
            glob: "compositions/**/*.tsx",
            elements: ["ef-timegroup", "Timegroup"],
            attribute: "duration",
            pattern: "^\\d+(\\.\\d+)?(s|ms)$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].file).toBe("compositions/video.tsx");
    expect(results[0].violations[0].message).toContain("<Timegroup>");
  });

  it("attribute-pattern with empty elements array produces warning violation", () => {
    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "VIDEO-05",
          rule: "All duration values must be valid CSS time strings",
          severity: "error",
          check: {
            kind: "attribute-pattern" as const,
            glob: "compositions/**/*.tsx",
            elements: [],
            attribute: "duration",
            pattern: "^\\d+(\\.\\d+)?(s|ms)$",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].severity).toBe("warning");
    expect(results[0].violations[0].message).toContain("without elements or attribute");
  });

  it("link-resolution detects broken wikilinks", () => {
    writeFile(
      tempDir,
      "vault/note-1.md",
      "---\ntitle: Note 1\n---\nLink to [[note-2]] and [[missing-note]].",
    );
    writeFile(tempDir, "vault/note-2.md", "---\ntitle: Note 2\n---\nBack to [[note-1]].");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "NOTE-01",
          rule: "All wikilinks must resolve",
          severity: "error",
          check: {
            kind: "link-resolution",
            glob: "vault/**/*.md",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].invariantId).toBe("NOTE-01");
    expect(results[0].violations[0].file).toBe("vault/note-1.md");
    expect(results[0].violations[0].message).toContain("missing-note");
  });

  it("link-resolution passes when all links resolve", () => {
    writeFile(tempDir, "vault/note-1.md", "---\ntitle: Note 1\n---\nLink to [[note-2]].");
    writeFile(tempDir, "vault/note-2.md", "---\ntitle: Note 2\n---\nBack to [[note-1]].");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "NOTE-01",
          rule: "All wikilinks must resolve",
          severity: "error",
          check: {
            kind: "link-resolution",
            glob: "vault/**/*.md",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(0);
  });

  it("link-resolution resolves aliases", () => {
    writeFile(
      tempDir,
      "vault/note-1.md",
      "---\ntitle: Note 1\naliases: [alias-1]\n---\nLink to [[alias-1]].",
    );

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "NOTE-01",
          rule: "All wikilinks must resolve",
          severity: "error",
          check: {
            kind: "link-resolution",
            glob: "vault/**/*.md",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(0);
  });

  it("frontmatter-required detects missing title field", () => {
    writeFile(tempDir, "vault/note-1.md", "---\ntags: [a]\n---\nNo title here.");
    writeFile(tempDir, "vault/note-2.md", "---\ntitle: Note 2\n---\nHas title.");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "NOTE-02",
          rule: "Every note must have a title",
          severity: "warning",
          check: {
            kind: "frontmatter-required",
            glob: "vault/**/*.md",
            fields: ["title"],
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].invariantId).toBe("NOTE-02");
    expect(results[0].violations[0].file).toBe("vault/note-1.md");
    expect(results[0].violations[0].message).toContain("title");
  });

  it("frontmatter-required falls back to first H1 for title", () => {
    writeFile(tempDir, "vault/note-1.md", "---\ntags: [a]\n---\n# My Title\nContent.");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "NOTE-02",
          rule: "Every note must have a title",
          severity: "warning",
          check: {
            kind: "frontmatter-required",
            glob: "vault/**/*.md",
            fields: ["title"],
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(0);
  });

  it("frontmatter-required flags files without frontmatter", () => {
    writeFile(tempDir, "vault/note-1.md", "No frontmatter here.");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "NOTE-02",
          rule: "Every note must have a title",
          severity: "warning",
          check: {
            kind: "frontmatter-required",
            glob: "vault/**/*.md",
            fields: ["title"],
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].message).toContain("no frontmatter");
  });

  it("path-exclusion detects code files in vault", () => {
    writeFile(tempDir, "vault/note.md", "---\ntitle: Note\n---\nContent.");
    writeFile(tempDir, "vault/script.ts", "export const x = 1;");
    writeFile(tempDir, "vault/helper.py", "print('hello')");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "NOTE-03",
          rule: "No executable code files in vault",
          severity: "error",
          check: {
            kind: "path-exclusion",
            glob: "vault/**/*.{ts,mjs,js,py,sh}",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(2);
    const files = results[0].violations.map((v) => v.file).sort();
    expect(files).toEqual(["vault/helper.py", "vault/script.ts"]);
  });

  it("path-exclusion passes when no code files exist", () => {
    writeFile(tempDir, "vault/note.md", "---\ntitle: Note\n---\nContent.");

    const profile: StackProfile = {
      ...baseProfile,
      invariants: [
        {
          id: "NOTE-03",
          rule: "No executable code files in vault",
          severity: "error",
          check: {
            kind: "path-exclusion",
            glob: "vault/**/*.{ts,mjs,js,py,sh}",
          },
        },
      ],
    };

    const results = checkInvariants(profile, tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(0);
  });
});
