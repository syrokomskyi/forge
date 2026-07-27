/*
<MODULE_CONTRACT>
<purpose>Trivial string utilities — inlined from @gogol/share to avoid dependency.</purpose>
<non-goals>
  <item>Do not add non-string utilities here — use dedicated utility modules.</item>
  <item>Do not introduce @gogol/* imports — this package must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial inline of toKebabCase from @gogol/share/string-utils.</item>
</CHANGE_SUMMARY>
*/

export function toKebabCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
