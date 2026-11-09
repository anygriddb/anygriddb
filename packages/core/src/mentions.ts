/**
 * Mentions in comments are written `@[Display name](user-id)`. The name is
 * only for reading; the id decides who is notified.
 */
const MENTION =
  /@\[([^\]\n]{1,100})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

export const MAX_MENTIONS = 20;

/** Distinct mentioned user ids, in order, at most 20. */
export function parseMentions(body: string): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(MENTION)) {
    const id = match[2]?.toLowerCase();
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_MENTIONS) break;
  }
  return ids;
}

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; name: string; userId: string };

/** Splits a comment into text and mentions, for display. */
export function mentionSegments(body: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION)) {
    const index = match.index;
    if (index > last)
      segments.push({ kind: "text", text: body.slice(last, index) });
    segments.push({
      kind: "mention",
      name: match[1] ?? "",
      userId: (match[2] ?? "").toLowerCase(),
    });
    last = index + match[0].length;
  }
  if (last < body.length)
    segments.push({ kind: "text", text: body.slice(last) });
  return segments;
}

/** The markup inserted when a collaborator is picked. Brackets in names are dropped. */
export function mentionMarkup(name: string, userId: string): string {
  const clean =
    name
      .replace(/[[\]\n]/g, "")
      .trim()
      .slice(0, 100) || "?";
  return `@[${clean}](${userId})`;
}

/** Comment text with mentions shown as `@Name`, e.g. for emails. */
export function plainMentions(body: string): string {
  return mentionSegments(body)
    .map((segment) =>
      segment.kind === "text" ? segment.text : `@${segment.name}`,
    )
    .join("");
}
