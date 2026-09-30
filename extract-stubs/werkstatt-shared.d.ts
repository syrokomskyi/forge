/*
<MODULE_CONTRACT>
<purpose>Ambient module stubs for @warpgogol/werkstatt-shared, injected into the
standalone export only (extract.config.yaml postProcess). The monorepo resolves
the real workspace package; the standalone build has no such dependency and
must still compile type-only imports and the workspace-deps dynamic-import
bridge.</purpose>
<non-goals>
  <item>Does not replicate the real type shapes — permissive Record/any stubs keep the standalone build forward-compatible when werkstatt-shared grows new members.</item>
  <item>Not included in the monorepo tsconfig (lives outside src/os/bin include globs) — no module-declaration conflict with the real package.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Stubs are permissive on purpose: published werkstatt-shared versions lag the monorepo interface, so precise member lists would break the standalone build on every addition.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>ADR-0019: ambient stubs keep forge dependency-free while type-only imports (WorkspaceIO, ExecOptions, ExecResult, GeneratedArtifactSpec) compile standalone.</item>
</CHANGE_SUMMARY>
*/

/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "@warpgogol/werkstatt-shared/kernel/workspace-io" {
  export type WorkspaceIO = Record<string, any>;
}

declare module "@warpgogol/werkstatt-shared/kernel/types" {
  export type GeneratedArtifactSpec = Record<string, any>;
}

declare module "@warpgogol/werkstatt-shared/kernel" {
  export type ExecOptions = Record<string, any>;
  export type ExecResult = Record<string, any>;
  export type WorkspaceIO = Record<string, any>;
}

declare module "@warpgogol/werkstatt-shared/node/fs" {
  export const collectFiles: any;
}

declare module "@warpgogol/werkstatt-shared/fingerprint" {
  export const byteHashFile: any;
}

declare module "@warpgogol/werkstatt-shared/node/import-scan" {
  export const scanDirectoryForImports: any;
}
