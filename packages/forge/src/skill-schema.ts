/*
<MODULE_CONTRACT>
<purpose>Define the Zod frontmatter schema used by forge skill validation commands.</purpose>
<non-goals>
  <item>Do not validate SKILL.md body content — that is handled by pattern matching in the validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial skillFrontmatterSchema with name, description, invocation, category, concerns, dependsOn, languagePolicy.</item>
  <item>RFC-0393: added optional bindings field (requires/optional arrays of binding keys).</item>
  <item>RFC-0523: expanded concerns enum from binary to four-level taxonomy (read-only | document-only | content-mutation | code-mutation).</item>
  <item>RFC-0524: added optional knowledge field (array of file names relative to SKILL.md directory).</item>
  <item>RFC-0548: added optional triggers field (array of natural-language trigger phrases, max 5 entries, each 5-100 chars) for intent-to-skill routing.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

export const skillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).max(200),
  invocation: z.enum(["user", "model"]),
  category: z.enum(["fo", "shared", "meta"]),
  concerns: z.enum(["read-only", "document-only", "content-mutation", "code-mutation"]),
  dependsOn: z.array(z.string()).default([]),
  languagePolicy: z.literal("ref(PREFERENCES.md)"),
  bindings: z
    .object({
      requires: z.array(z.string()).default([]),
      optional: z.array(z.string()).default([]),
    })
    .optional(),
  knowledge: z.array(z.string()).optional(),
  triggers: z.array(z.string().min(5).max(100)).max(5).optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
