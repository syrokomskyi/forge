/*
<MODULE_CONTRACT>
<purpose>Vitest setup: strip repository-locating git variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, …) before any test runs, so fixture repositories created in temp dirs can never write into the workspace repository.</purpose>
<non-goals>
  <item>Does not change any other environment variable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-src + forge root eslint</item>
</CHANGE_SUMMARY>
*/

for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
]) {
  delete process.env[key];
}
