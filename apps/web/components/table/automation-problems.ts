import {
  automationSecretInputSchema,
  type AutomationAction,
  type AutomationStep,
} from "@anygriddb/core";

/** A part of an automation that can still be missing. */
export type AutomationPart =
  | "name"
  | "values"
  | "to"
  | "subject"
  | "url"
  | "message"
  | "users"
  | "code"
  | "secretName"
  | "secretHost"
  | "secretValue";

/**
 * What a part still needs, and where: `at` is the action's place, `a0`
 * for the first, `a1.then0` for the first step of the second's branch,
 * `a1.otherwise0`, `a2.each0` inside a loop, `s0` for the first secret;
 * the name has none.
 */
export type AutomationProblem = { at: string; part: AutomationPart };

/** The key of a problem, as the editor looks it up. */
export function problemKey(at: string, part: AutomationPart): string {
  return at ? `${at}:${part}` : part;
}

/** The id of the control that holds a part, and of its message (`-problem`). */
export function partControl(at: string, part: AutomationPart): string {
  return at
    ? `automation-${at.replaceAll(".", "-")}-${part}`
    : `automation-${part}`;
}

/**
 * Whether the server could read an address an action posts to: HTTPS, a
 * host, nothing it cannot parse. Whether it is public is the server's to
 * say, once it has looked the name up.
 */
export function isPostAddress(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://") || !URL.canParse(trimmed)) return false;
  return new URL(trimmed).hostname !== "";
}

function stepProblems(
  step: AutomationStep,
  at: string,
  scripts: boolean,
): AutomationProblem[] {
  const missing = (part: AutomationPart, empty: boolean) =>
    empty ? [{ at, part }] : [];
  switch (step.type) {
    case "update_record":
      // An update that writes nothing is a step left half made.
      return missing("values", Object.keys(step.values).length === 0);
    case "send_email":
      return [
        ...missing("to", !step.to.trim()),
        ...missing("subject", !step.subject.trim()),
      ];
    case "call_webhook":
      return missing("url", !isPostAddress(step.url));
    case "send_slack":
    case "send_teams":
      return [
        ...missing("url", !isPostAddress(step.url)),
        ...missing("message", !step.message.trim()),
      ];
    case "notify":
      return [
        ...missing("users", step.users.length === 0),
        ...missing("message", !step.message.trim()),
      ];
    case "run_script":
      return missing("code", !scripts);
    case "delete_record":
    case "create_record":
      return [];
  }
}

/** A secret as the editor holds it: a kept one may leave its value empty. */
export type SecretDraft = {
  name: string;
  host: string;
  value: string;
  kept: boolean;
};

const SECRET = automationSecretInputSchema.shape;

function secretProblems(secrets: readonly SecretDraft[]): AutomationProblem[] {
  const names = secrets.map((secret) => secret.name.trim());
  return secrets.flatMap((secret, index) => {
    const at = `s${String(index)}`;
    const name = names[index] ?? "";
    return [
      ...(SECRET.name.safeParse(name).success && names.indexOf(name) === index
        ? []
        : [{ at, part: "secretName" as const }]),
      ...(SECRET.host.safeParse(secret.host).success
        ? []
        : [{ at, part: "secretHost" as const }]),
      ...(secret.value || secret.kept
        ? []
        : [{ at, part: "secretValue" as const }]),
    ];
  });
}

/**
 * What an automation still needs before the server can keep it, in the
 * order the editor shows it: what the server would otherwise refuse as
 * "invalid input" without saying which part, and an update that writes
 * nothing. `scripts` is whether the instance runs scripts.
 */
export function automationProblems(
  draft: {
    name: string;
    actions: readonly AutomationAction[];
    secrets?: readonly SecretDraft[];
  },
  scripts: boolean,
): AutomationProblem[] {
  const found: AutomationProblem[] = draft.name.trim()
    ? []
    : [{ at: "", part: "name" }];
  draft.actions.forEach((action, index) => {
    const at = `a${String(index)}`;
    const steps = (list: readonly AutomationStep[], where: string) =>
      list.flatMap((step, place) =>
        stepProblems(step, `${at}.${where}${String(place)}`, scripts),
      );
    if (action.type === "branch") {
      found.push(
        ...steps(action.then, "then"), // NOSONAR: a stored JSON key holding steps, never a function
        ...steps(action.otherwise ?? [], "otherwise"),
      );
    } else if (action.type === "for_each") {
      found.push(...steps(action.actions, "each"));
    } else {
      found.push(...stepProblems(action, at, scripts));
    }
  });
  return [...found, ...secretProblems(draft.secrets ?? [])];
}
