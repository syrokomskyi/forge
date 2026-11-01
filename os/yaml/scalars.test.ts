/*
<MODULE_CONTRACT>
<purpose>scalars.test unit coverage for collectScalarTraps — loud one-line traps,
silent continuation reinterpretation, and every documented exclusion class.</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1478: initial suite — trap shapes, exclusions, frontmatter scope.</item>
  <item>RFC-1478: yaml.scalars.validate + EC-25 colon-space staged lint (F-0006)</item>
  <item>RFC-1485: sweep compass headers — forge-os-tail</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";

import { collectScalarTraps, yamlScalarCandidateSkipped } from "./handlers/scalars-validate.ts";

const YAML_DOC = `id: e-1
summary: something with cacheable: false inside
status: open
`;

describe("collectScalarTraps — loud one-line shape", () => {
  it("flags an unquoted value containing colon-space", () => {
    const traps = collectScalarTraps("docs/x.yaml", YAML_DOC);
    expect(traps).toHaveLength(1);
    expect(traps[0]).toMatchObject({ file: "docs/x.yaml", line: 2, key: "summary" });
    expect(traps[0]!.preview).toContain("cacheable: false");
  });

  it("flags colon-space inside a sequence item entry", () => {
    const raw = `- item: one: two
- item: fine
`;
    const traps = collectScalarTraps("a.yaml", raw);
    expect(traps).toHaveLength(1);
    expect(traps[0]!.key).toBe("item");
  });
});

describe("collectScalarTraps — silent continuation shape", () => {
  it("flags a plain scalar followed by a deeper-indented key line", () => {
    const raw = `summary: this is prose
  cacheable: false meant as continuation
`;
    const traps = collectScalarTraps("a.yaml", raw);
    expect(traps).toHaveLength(1);
    expect(traps[0]!.key).toBe("summary");
  });

  it("does not flag a sequence item's second map key", () => {
    const raw = `- summary: first
  status: open
- summary: second
  status: closed
`;
    expect(collectScalarTraps("a.yaml", raw)).toHaveLength(0);
  });

  it("does not flag a normal nested map (empty parent value)", () => {
    const raw = `parent:
  child: value
  other: value2
`;
    expect(collectScalarTraps("a.yaml", raw)).toHaveLength(0);
  });
});

describe("collectScalarTraps — exclusions", () => {
  it("skips quoted scalars carrying colon-space", () => {
    const raw = `a: "quoted: value"
b: 'single: quoted'
`;
    expect(collectScalarTraps("a.yaml", raw)).toHaveLength(0);
  });

  it("skips block scalar content", () => {
    const raw = `desc: |
  line with colon: inside block
  more: text
next: fine
`;
    expect(collectScalarTraps("a.yaml", raw)).toHaveLength(0);
  });

  it("skips folded block scalar content", () => {
    const raw = `desc: >
  folded: text here
`;
    expect(collectScalarTraps("a.yaml", raw)).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const raw = `# note: with colon: inside
value: ok
`;
    expect(collectScalarTraps("a.yaml", raw)).toHaveLength(0);
  });

  it("skips flow collections as values", () => {
    const raw = `m: {a: b, c: d}
s: [x, y]
`;
    expect(collectScalarTraps("a.yaml", raw)).toHaveLength(0);
  });

  it("skips values whose colon-space sits inside an inner quote", () => {
    const raw = `msg: say "hello: world" loudly
`;
    expect(collectScalarTraps("a.yaml", raw)).toHaveLength(0);
  });
});

describe("collectScalarTraps — .md frontmatter scope", () => {
  it("scans frontmatter only — body prose with colon-space is ignored", () => {
    const raw = `---
title: broken: title
---
Body prose: not yaml: at all.
More: prose here.
`;
    const traps = collectScalarTraps("doc.md", raw);
    expect(traps).toHaveLength(1);
    expect(traps[0]!.line).toBe(2);
    expect(traps[0]!.key).toBe("title");
  });

  it("returns nothing for .md without frontmatter", () => {
    expect(collectScalarTraps("doc.md", "# Title\nbody: x\n")).toHaveLength(0);
  });

  it("returns nothing for unsupported extensions", () => {
    expect(collectScalarTraps("x.txt", "a: b: c\n")).toHaveLength(0);
  });
});

describe("yamlScalarCandidateSkipped", () => {
  it("skips template files and templates/ dirs", () => {
    expect(yamlScalarCandidateSkipped("x/foo.template.yaml")).toBe(true);
    expect(yamlScalarCandidateSkipped("x/templates/foo.yaml")).toBe(true);
  });
  it("skips excluded dirs and dash-prefixed segments", () => {
    expect(yamlScalarCandidateSkipped("node_modules/x.yaml")).toBe(true);
    expect(yamlScalarCandidateSkipped("-drafts/x.yaml")).toBe(true);
  });
  it("admits authored yaml and md", () => {
    expect(yamlScalarCandidateSkipped("docs/frictions.yaml")).toBe(false);
    expect(yamlScalarCandidateSkipped("docs/rfcs/rfc-1.md")).toBe(false);
  });
});
