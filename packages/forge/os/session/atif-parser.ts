/*
<MODULE_CONTRACT>
<purpose>
ATIF format parser — converts raw Devin CLI --export output to structured
message turns. Starts with raw text passthrough since no ATIF format spec
exists in the codebase. Format-specific parsing logic is added incrementally
as real Devin exports are tested.
</purpose>
<non-goals>
  <item>Do not perform metadata extraction — that lives in the save handler.</item>
  <item>Do not write files — the save handler owns I/O.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0537: initial ATIF parser with raw text passthrough fallback.</item>
</CHANGE_SUMMARY>
*/

export interface AtifMessage {
  role: "user" | "assistant" | "system" | "unknown";
  timestamp: string | null;
  content: string;
}

export interface AtifParseResult {
  messages: AtifMessage[];
  rawContent: string;
  /** True if the content was parsed as structured ATIF, false if raw passthrough */
  parsed: boolean;
}

/**
 * Parse raw ATIF content from Devin CLI --export.
 *
 * The initial implementation uses raw text passthrough — the entire content
 * is treated as a single message with role "unknown". This ensures session.save
 * works immediately without needing a real ATIF sample to reverse-engineer
 * the format. As real Devin exports are tested, format-specific parsing
 * logic is added here.
 *
 * Fallback: if any parsing attempt fails, the raw content is preserved
 * as a single message.
 */
export function parseAtif(rawContent: string): AtifParseResult {
  if (!rawContent || rawContent.trim().length === 0) {
    return { messages: [], rawContent, parsed: false };
  }

  // Try JSON-lines format (each line is a JSON object with role/content)
  const jsonLinesResult = tryParseJsonLines(rawContent);
  if (jsonLinesResult) {
    return jsonLinesResult;
  }

  // Try structured ATIF with delimiters (e.g. "--- turn N ---" or "## Role: user")
  const delimitedResult = tryParseDelimited(rawContent);
  if (delimitedResult) {
    return delimitedResult;
  }

  // Fallback: raw text passthrough — single message
  return {
    messages: [
      {
        role: "unknown",
        timestamp: null,
        content: rawContent,
      },
    ],
    rawContent,
    parsed: false,
  };
}

function tryParseJsonLines(rawContent: string): AtifParseResult | null {
  const lines = rawContent.split("\n").filter((l) => l.trim().length > 0);
  const messages: AtifMessage[] = [];
  let anyParsed = false;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj === "object" && obj !== null && ("role" in obj || "content" in obj)) {
        messages.push({
          role: (obj["role"] as AtifMessage["role"]) ?? "unknown",
          timestamp: typeof obj["timestamp"] === "string" ? (obj["timestamp"] as string) : null,
          content: typeof obj["content"] === "string" ? (obj["content"] as string) : String(obj["content"] ?? ""),
        });
        anyParsed = true;
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }

  return anyParsed ? { messages, rawContent, parsed: true } : null;
}

function tryParseDelimited(rawContent: string): AtifParseResult | null {
  // Check for common delimiter patterns
  const delimiterPatterns = [
    /^#{1,3}\s*(?:Role|role):\s*(user|assistant|system)\s*$/gm,
    /^---\s*(?:turn\s*)?(\d+)\s*---\s*$/gm,
  ];

  for (const pattern of delimiterPatterns) {
    const matches = [...rawContent.matchAll(pattern)];
    if (matches.length === 0) continue;

    const messages: AtifMessage[] = [];
    let lastEnd = 0;
    let lastRole: AtifMessage["role"] = "unknown";
    let lastTimestamp: string | null = null;

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      if (i > 0 && match.index! > lastEnd) {
        const content = rawContent.slice(lastEnd, match.index).trim();
        if (content) {
          messages.push({ role: lastRole, timestamp: lastTimestamp, content });
        }
      }
      const roleMatch = match[1]?.toLowerCase();
      lastRole = (roleMatch as AtifMessage["role"]) ?? "unknown";
      lastEnd = match.index! + match[0].length;
    }

    if (lastEnd < rawContent.length) {
      const content = rawContent.slice(lastEnd).trim();
      if (content) {
        messages.push({ role: lastRole, timestamp: lastTimestamp, content });
      }
    }

    if (messages.length > 0) {
      return { messages, rawContent, parsed: true };
    }
  }

  return null;
}

/**
 * Convert parsed ATIF messages to a markdown transcript section.
 */
export function messagesToTranscriptMarkdown(messages: AtifMessage[]): string {
  if (messages.length === 0) {
    return "(empty transcript)";
  }

  const lines: string[] = [];
  for (const msg of messages) {
    const roleLabel = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
    const timestamp = msg.timestamp ? ` \[${msg.timestamp}\]` : "";
    lines.push(`### ${roleLabel}${timestamp}`);
    lines.push("");
    lines.push(msg.content);
    lines.push("");
  }
  return lines.join("\n").trim();
}
