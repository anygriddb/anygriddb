import { z } from "zod";
import { AppError, type ErrorCode } from "./errors";

/**
 * Formula language: an AST stored as JSON, a text syntax close to
 * spreadsheet formulas (`{Field} * 2`, `IF({Done}, "ok", "")`), and a
 * formatter back to text. Evaluation is SQL only (`formula-sql.ts`).
 * There is no eval.
 */

type FnSpec = { min: number; max: number };

export const FORMULA_FN_SPECS = {
  abs: { min: 1, max: 1 },
  round: { min: 1, max: 2 },
  roundup: { min: 1, max: 2 },
  rounddown: { min: 1, max: 2 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  int: { min: 1, max: 1 },
  mod: { min: 2, max: 2 },
  power: { min: 2, max: 2 },
  sqrt: { min: 1, max: 1 },
  exp: { min: 1, max: 1 },
  ln: { min: 1, max: 1 },
  log: { min: 1, max: 2 },
  sign: { min: 1, max: 1 },
  even: { min: 1, max: 1 },
  odd: { min: 1, max: 1 },
  sum: { min: 1, max: 30 },
  average: { min: 1, max: 30 },
  min: { min: 1, max: 30 },
  max: { min: 1, max: 30 },
  value: { min: 1, max: 1 },
  concat: { min: 1, max: 30 },
  lower: { min: 1, max: 1 },
  upper: { min: 1, max: 1 },
  len: { min: 1, max: 1 },
  trim: { min: 1, max: 1 },
  left: { min: 2, max: 2 },
  right: { min: 2, max: 2 },
  mid: { min: 2, max: 3 },
  find: { min: 2, max: 3 },
  search: { min: 2, max: 3 },
  substitute: { min: 3, max: 3 },
  replace: { min: 4, max: 4 },
  rept: { min: 2, max: 2 },
  t: { min: 1, max: 1 },
  encode_url_component: { min: 1, max: 1 },
  text_before: { min: 2, max: 2 },
  text_after: { min: 2, max: 2 },
  json_extract: { min: 2, max: 2 },
  regex_match: { min: 2, max: 2 },
  regex_extract: { min: 2, max: 2 },
  regex_replace: { min: 3, max: 3 },
  md5: { min: 1, max: 1 },
  sha256: { min: 1, max: 1 },
  sha512: { min: 1, max: 1 },
  and: { min: 1, max: 30 },
  or: { min: 1, max: 30 },
  xor: { min: 1, max: 30 },
  not: { min: 1, max: 1 },
  if: { min: 2, max: 3 },
  switch: { min: 3, max: 30 },
  blank: { min: 0, max: 0 },
  is_blank: { min: 1, max: 1 },
  is_not_blank: { min: 1, max: 1 },
  error: { min: 0, max: 1 },
  is_error: { min: 1, max: 1 },
  true: { min: 0, max: 0 },
  false: { min: 0, max: 0 },
  today: { min: 0, max: 0 },
  now: { min: 0, max: 0 },
  year: { min: 1, max: 1 },
  month: { min: 1, max: 1 },
  day: { min: 1, max: 1 },
  hour: { min: 1, max: 1 },
  minute: { min: 1, max: 1 },
  second: { min: 1, max: 1 },
  weekday: { min: 1, max: 1 },
  weeknum: { min: 1, max: 1 },
  datetime_diff: { min: 2, max: 3 },
  date_add: { min: 3, max: 3 },
  datestr: { min: 1, max: 1 },
  datetime_parse: { min: 1, max: 2 },
  fromnow: { min: 1, max: 2 },
  tonow: { min: 1, max: 2 },
  workday: { min: 2, max: 3 },
  workday_diff: { min: 2, max: 3 },
  datetime_format: { min: 2, max: 2 },
  is_before: { min: 2, max: 2 },
  is_after: { min: 2, max: 2 },
  is_same: { min: 2, max: 3 },
  record_id: { min: 0, max: 0 },
  autonumber: { min: 0, max: 0 },
  created_time: { min: 0, max: 0 },
  last_modified_time: { min: 0, max: 0 },
  array_join: { min: 1, max: 2 },
  array_unique: { min: 1, max: 1 },
  array_compact: { min: 1, max: 1 },
  array_sort: { min: 1, max: 2 },
  array_slice: { min: 2, max: 3 },
  array_flatten: { min: 1, max: 30 },
  text_split: { min: 2, max: 2 },
  count: { min: 1, max: 30 },
  counta: { min: 1, max: 30 },
  countall: { min: 1, max: 30 },
} as const satisfies Record<string, FnSpec>;

export type FormulaFn = keyof typeof FORMULA_FN_SPECS;

export const FORMULA_FNS = Object.keys(FORMULA_FN_SPECS) as [
  FormulaFn,
  ...FormulaFn[],
];

const FN_ALIASES: Record<string, FormulaFn> = {
  concatenate: "concat",
  ceiling: "ceil",
  avg: "average",
  isblank: "is_blank",
  isnotblank: "is_not_blank",
  iserror: "is_error",
  substr: "mid",
  textbefore: "text_before",
  textafter: "text_after",
  split: "text_split",
  regexp_match: "regex_match",
  regexp_extract: "regex_extract",
  regexp_replace: "regex_replace",
  textsplit: "text_split",
  arraysort: "array_sort",
  arrayslice: "array_slice",
  length: "len",
  datetime_add: "date_add",
  dateadd: "date_add",
  datediff: "datetime_diff",
  from_now: "fromnow",
  to_now: "tonow",
  encode_url: "encode_url_component",
};

type BinaryOp =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "mod"
  | "concat"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export type FormulaExpr =
  | { op: "num"; value: number }
  | { op: "str"; value: string }
  | { op: "bool"; value: boolean }
  | { op: "col"; name: string }
  | { op: "neg"; arg: FormulaExpr }
  | { op: BinaryOp; left: FormulaExpr; right: FormulaExpr }
  | { op: "if"; cond: FormulaExpr; then: FormulaExpr; else: FormulaExpr }
  | { op: "call"; fn: FormulaFn; args: FormulaExpr[] };

const BINARY_OPS = [
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "concat",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

const COLUMN_REF = /^[a-z_][a-z0-9_]*$/;

const MAX_FORMULA_NODES = 500;
const MAX_FORMULA_DEPTH = 40;
const MAX_FORMULA_SOURCE = 4_000;

const nodeSchema: z.ZodType<FormulaExpr> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal("num"), value: z.number() }).strict(),
    z.object({ op: z.literal("str"), value: z.string().max(1_000) }).strict(),
    z.object({ op: z.literal("bool"), value: z.boolean() }).strict(),
    z
      .object({
        op: z.literal("col"),
        name: z.string().regex(COLUMN_REF).max(63),
      })
      .strict(),
    z.object({ op: z.literal("neg"), arg: nodeSchema }).strict(),
    z
      .object({
        op: z.enum(BINARY_OPS),
        left: nodeSchema,
        right: nodeSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal("if"),
        cond: nodeSchema,
        then: nodeSchema,
        else: nodeSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal("call"),
        fn: z.enum(FORMULA_FNS),
        args: z.array(nodeSchema).max(30),
      })
      .strict(),
  ]),
);

/** Stored AST, with node-count, depth, and arity limits. */
export const formulaExprSchema: z.ZodType<FormulaExpr> = nodeSchema.superRefine(
  (expr, context) => {
    try {
      assertFormulaShape(expr);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid formula",
      });
    }
  },
);

export function formulaChildren(expr: FormulaExpr): FormulaExpr[] {
  switch (expr.op) {
    case "num":
    case "str":
    case "bool":
    case "col":
      return [];
    case "neg":
      return [expr.arg];
    case "if":
      return [expr.cond, expr.then, expr.else];
    case "call":
      return expr.args;
    default:
      return [expr.left, expr.right];
  }
}

/** Rejects ASTs that are too large, too deep, or call a function with the wrong arity. */
function assertFormulaShape(expr: FormulaExpr): void {
  let nodes = 0;
  const visit = (node: FormulaExpr, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_FORMULA_NODES || depth > MAX_FORMULA_DEPTH) {
      throw new AppError("formula_too_large");
    }
    if (node.op === "call") {
      const spec: FnSpec = FORMULA_FN_SPECS[node.fn];
      if (node.args.length < spec.min || node.args.length > spec.max) {
        throw new AppError("invalid_arguments", node.fn);
      }
    }
    for (const child of formulaChildren(node)) {
      visit(child, depth + 1);
    }
  };
  visit(expr, 0);
}

/** Column names the formula reads, in first-seen order. */
export function formulaReferences(expr: FormulaExpr): string[] {
  const seen = new Set<string>();
  const visit = (node: FormulaExpr): void => {
    if (node.op === "col") {
      seen.add(node.name);
    }
    for (const child of formulaChildren(node)) {
      visit(child);
    }
  };
  visit(expr);
  return [...seen];
}

export type FormulaRef = { name: string; label: string };

/** Where a token sits in the text the tokenizer read: `[from, to)`. */
type Span = { from: number; to: number };

type Token = Span &
  (
    | { type: "num"; value: number }
    | { type: "str"; value: string }
    | { type: "ref"; value: string }
    | { type: "ident"; value: string }
    | { type: "op"; value: string }
    | { type: "lparen" }
    | { type: "rparen" }
    | { type: "comma" }
  );

/**
 * A formula error with the stretch of text it is about, so an editor can
 * underline it. To the API it is the AppError it extends.
 */
class FormulaError extends AppError {
  constructor(
    code: ErrorCode,
    readonly span: Span,
    detail?: string,
  ) {
    super(code, detail);
  }
}

const OPERATORS = [
  "<=",
  ">=",
  "<>",
  "!=",
  "==",
  "&&",
  "||",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    const from = index;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(") {
      index += 1;
      tokens.push({ type: "lparen", from, to: index });
      continue;
    }
    if (char === ")") {
      index += 1;
      tokens.push({ type: "rparen", from, to: index });
      continue;
    }
    if (char === "," || char === ";") {
      index += 1;
      tokens.push({ type: "comma", from, to: index });
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\" && index + 1 < source.length) {
          const next = source[index + 1] ?? "";
          // `\n`, `\t`, and a backslash or a quote escaped; before anything
          // else the backslash stays, so a pattern reads as written: "\d+".
          value +=
            next === "n"
              ? "\n"
              : next === "t"
                ? "\t"
                : next === "\\" || next === '"' || next === "'"
                  ? next
                  : `\\${next}`;
          index += 2;
          continue;
        }
        value += source.charAt(index);
        index += 1;
      }
      if (source[index] !== quote) {
        throw new FormulaError("unterminated_string", { from, to: index });
      }
      index += 1;
      if (value.length > 1_000) {
        throw new FormulaError("invalid_formula", { from, to: index });
      }
      tokens.push({ type: "str", value, from, to: index });
      continue;
    }
    if (char === "{") {
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== "}") {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source.charAt(index + 1);
          index += 2;
          continue;
        }
        value += source.charAt(index);
        index += 1;
      }
      if (source[index] !== "}") {
        throw new FormulaError("unterminated_field_reference", {
          from,
          to: index,
        });
      }
      index += 1;
      tokens.push({ type: "ref", value: value.trim(), from, to: index });
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(
        source.slice(index),
      );
      const to = index + (match?.[0].length ?? 1);
      if (!match) {
        throw new FormulaError("invalid_number", { from, to });
      }
      const value = Number(match[0]);
      if (!Number.isFinite(value)) {
        throw new FormulaError("invalid_number", { from, to });
      }
      tokens.push({ type: "num", value, from, to });
      index = to;
      continue;
    }
    if (/[\p{L}_]/u.test(char)) {
      const match = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(source.slice(index));
      const value = match?.[0] ?? char;
      index += value.length;
      tokens.push({ type: "ident", value, from, to: index });
      continue;
    }
    const op = OPERATORS.find((candidate) =>
      source.startsWith(candidate, index),
    );
    if (!op) {
      throw new FormulaError(
        "unexpected_character",
        { from, to: from + 1 },
        char,
      );
    }
    index += op.length;
    tokens.push({ type: "op", value: op, from, to: index });
  }
  return tokens;
}

/** The function a name calls, its aliases read: `AVG` is AVERAGE. */
export function formulaFunction(raw: string): FormulaFn | undefined {
  const lower = raw.toLowerCase();
  // Own keys only: `constructor` is no function.
  if (Object.hasOwn(FORMULA_FN_SPECS, lower)) {
    return lower as FormulaFn;
  }
  return Object.hasOwn(FN_ALIASES, lower) ? FN_ALIASES[lower] : undefined;
}

function resolveFunction(raw: string, span: Span): FormulaFn {
  const fn = formulaFunction(raw);
  if (fn) {
    return fn;
  }
  throw new FormulaError("unknown_function", span, raw);
}

const COMPARISONS: Record<string, BinaryOp> = {
  "=": "eq",
  "==": "eq",
  "!=": "neq",
  "<>": "neq",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

/**
 * Parses formula text. `{Label}` and bare identifiers resolve against
 * `refs` by label first, then by name. Function names are case-insensitive.
 */
export function parseFormula(
  source: string,
  refs: readonly FormulaRef[],
): FormulaExpr {
  const input = source.trim();
  if (input.length === 0 || input.length > MAX_FORMULA_SOURCE) {
    throw new AppError("invalid_formula");
  }
  // Spans count from the start of `source`, past its spaces and the `=`.
  const offset =
    source.length - source.trimStart().length + (input.startsWith("=") ? 1 : 0);
  const shift = (span: Span): Span => ({
    from: span.from + offset,
    to: span.to + offset,
  });
  let tokens: Token[];
  try {
    tokens = tokenize(input.startsWith("=") ? input.slice(1) : input);
  } catch (error) {
    if (error instanceof FormulaError) {
      throw new FormulaError(error.code, shift(error.span), error.detail);
    }
    throw error;
  }
  const end: Span = { from: source.length, to: source.length };
  /** The token at `at`, or the end of the text past the last one. */
  const spanAt = (at: number): Span => {
    const token = tokens[at];
    return token ? shift(token) : end;
  };
  let index = 0;
  let depth = 0;

  const peek = (): Token | undefined => tokens[index];
  const isOp = (value: string): boolean => {
    const token = peek();
    return token?.type === "op" && token.value === value;
  };
  const resolveRef = (raw: string, span: Span): FormulaExpr => {
    const byLabel = refs.find((ref) => ref.label === raw);
    const byLabelFolded =
      byLabel ??
      refs.find((ref) => ref.label.toLowerCase() === raw.toLowerCase());
    const match = byLabelFolded ?? refs.find((ref) => ref.name === raw);
    if (!match) {
      throw new FormulaError("unknown_field", shift(span), raw);
    }
    return { op: "col", name: match.name };
  };
  const enter = (): void => {
    depth += 1;
    if (depth > MAX_FORMULA_DEPTH) {
      throw new FormulaError("formula_too_large", spanAt(index));
    }
  };

  function parseOr(): FormulaExpr {
    let left = parseAnd();
    while (isOp("||")) {
      index += 1;
      left = { op: "call", fn: "or", args: [left, parseAnd()] };
    }
    return left;
  }

  function parseAnd(): FormulaExpr {
    let left = parseComparison();
    while (isOp("&&")) {
      index += 1;
      left = { op: "call", fn: "and", args: [left, parseComparison()] };
    }
    return left;
  }

  function parseComparison(): FormulaExpr {
    let left = parseConcat();
    for (;;) {
      const token = peek();
      const op = token?.type === "op" ? COMPARISONS[token.value] : undefined;
      if (!op) {
        return left;
      }
      index += 1;
      left = { op, left, right: parseConcat() };
    }
  }

  function parseConcat(): FormulaExpr {
    let left = parseAdditive();
    while (isOp("&")) {
      index += 1;
      left = { op: "concat", left, right: parseAdditive() };
    }
    return left;
  }

  function parseAdditive(): FormulaExpr {
    let left = parseMultiplicative();
    while (isOp("+") || isOp("-")) {
      const op = isOp("+") ? "add" : "sub";
      index += 1;
      left = { op, left, right: parseMultiplicative() };
    }
    return left;
  }

  function parseMultiplicative(): FormulaExpr {
    let left = parseUnary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = isOp("*") ? "mul" : isOp("/") ? "div" : "mod";
      index += 1;
      left = { op, left, right: parseUnary() };
    }
    return left;
  }

  function parseUnary(): FormulaExpr {
    if (isOp("-")) {
      index += 1;
      enter();
      const arg = parseUnary();
      depth -= 1;
      if (arg.op === "num") {
        return { op: "num", value: -arg.value };
      }
      return { op: "neg", arg };
    }
    if (isOp("+")) {
      index += 1;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): FormulaExpr {
    const token = peek();
    if (!token) {
      throw new FormulaError("unexpected_end_of_formula", end);
    }
    index += 1;
    switch (token.type) {
      case "num":
        return { op: "num", value: token.value };
      case "str":
        return { op: "str", value: token.value };
      case "ref":
        return resolveRef(token.value, token);
      case "lparen": {
        enter();
        const inner = parseOr();
        depth -= 1;
        if (peek()?.type !== "rparen") {
          throw new FormulaError("missing_closing_parenthesis", spanAt(index));
        }
        index += 1;
        return inner;
      }
      case "ident": {
        if (peek()?.type === "lparen") {
          index += 1;
          enter();
          const fn = resolveFunction(token.value, shift(token));
          const args: FormulaExpr[] = [];
          if (peek()?.type !== "rparen") {
            args.push(parseOr());
            while (peek()?.type === "comma") {
              index += 1;
              args.push(parseOr());
            }
          }
          if (peek()?.type !== "rparen") {
            throw new FormulaError(
              "missing_closing_parenthesis",
              spanAt(index),
            );
          }
          index += 1;
          depth -= 1;
          const spec: FnSpec = FORMULA_FN_SPECS[fn];
          if (args.length < spec.min || args.length > spec.max) {
            throw new FormulaError("invalid_arguments", shift(token), fn);
          }
          if (fn === "if") {
            const [cond, then, otherwise] = args;
            if (!cond || !then) {
              throw new FormulaError("invalid_arguments", shift(token), "if");
            }
            return {
              op: "if",
              cond,
              then,
              else: otherwise ?? { op: "call", fn: "blank", args: [] },
            };
          }
          return { op: "call", fn, args };
        }
        const lower = token.value.toLowerCase();
        if (lower === "true" || lower === "false") {
          return { op: "bool", value: lower === "true" };
        }
        return resolveRef(token.value, token);
      }
      default:
        throw new FormulaError("invalid_formula", shift(token));
    }
  }

  const expr = parseOr();
  if (index !== tokens.length) {
    throw new FormulaError("invalid_formula", spanAt(index));
  }
  assertFormulaShape(expr);
  return expr;
}

const BINARY_TEXT: Record<BinaryOp, { text: string; precedence: number }> = {
  eq: { text: "=", precedence: 1 },
  neq: { text: "!=", precedence: 1 },
  gt: { text: ">", precedence: 1 },
  gte: { text: ">=", precedence: 1 },
  lt: { text: "<", precedence: 1 },
  lte: { text: "<=", precedence: 1 },
  concat: { text: "&", precedence: 2 },
  add: { text: "+", precedence: 3 },
  sub: { text: "-", precedence: 3 },
  mul: { text: "*", precedence: 4 },
  div: { text: "/", precedence: 4 },
  mod: { text: "%", precedence: 4 },
};

function quoteText(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Formats an AST back to text, with `{Label}` for each column it reads. */
export function formatFormula(
  expr: FormulaExpr,
  refs: readonly FormulaRef[],
): string {
  const labelOf = (name: string): string => {
    const label = refs.find((ref) => ref.name === name)?.label ?? name;
    return `{${label.replace(/[\\}]/g, (char) => `\\${char}`)}}`;
  };
  const format = (node: FormulaExpr, parent: number): string => {
    switch (node.op) {
      case "num":
        return String(node.value);
      case "str":
        return quoteText(node.value);
      case "bool":
        return node.value ? "TRUE" : "FALSE";
      case "col":
        return labelOf(node.name);
      case "neg":
        return `-${format(node.arg, 5)}`;
      case "if":
        return `IF(${format(node.cond, 0)}, ${format(node.then, 0)}, ${format(node.else, 0)})`;
      case "call":
        return `${node.fn.toUpperCase()}(${node.args.map((arg) => format(arg, 0)).join(", ")})`;
      default: {
        const spec = BINARY_TEXT[node.op];
        const text = `${format(node.left, spec.precedence)} ${spec.text} ${format(node.right, spec.precedence + 1)}`;
        return spec.precedence < parent ? `(${text})` : text;
      }
    }
  };
  return format(expr, 0);
}

/** A token of formula text, for an editor's highlighting. */
type FormulaToken = {
  kind:
    | "number"
    | "string"
    | "field"
    | "function"
    | "name"
    | "operator"
    | "punctuation"
    | "invalid";
  from: number;
  to: number;
};

/**
 * The tokens of `source`, never failing: text the tokenizer cannot read
 * is one `invalid` token running to the end.
 */
export function formulaTokens(source: string): FormulaToken[] {
  let tokens: Token[];
  let failed: Span | undefined;
  try {
    tokens = tokenize(source);
  } catch (error) {
    if (!(error instanceof FormulaError)) throw error;
    failed = error.span;
    // The text before the failure reads; the rest is marked invalid.
    try {
      tokens = tokenize(source.slice(0, failed.from));
    } catch {
      tokens = [];
    }
  }
  const out: FormulaToken[] = tokens.map((token, at) => ({
    kind:
      token.type === "num"
        ? "number"
        : token.type === "str"
          ? "string"
          : token.type === "ref"
            ? "field"
            : token.type === "ident"
              ? tokens[at + 1]?.type === "lparen"
                ? "function"
                : "name"
              : token.type === "op"
                ? "operator"
                : "punctuation",
    from: token.from,
    to: token.to,
  }));
  if (failed)
    out.push({ kind: "invalid", from: failed.from, to: source.length });
  return out;
}

export type FormulaProblem = {
  code: ErrorCode;
  detail?: string;
  from: number;
  to: number;
};

/**
 * What is wrong with `source`, and where, or null when it parses. The
 * server checks again, with the types, when the field is saved.
 */
export function checkFormula(
  source: string,
  refs: readonly FormulaRef[],
): FormulaProblem | null {
  try {
    parseFormula(source, refs);
    return null;
  } catch (error) {
    if (error instanceof FormulaError) {
      return { code: error.code, detail: error.detail, ...error.span };
    }
    if (error instanceof AppError) {
      return {
        code: error.code,
        detail: error.detail,
        from: 0,
        to: source.length,
      };
    }
    throw error;
  }
}
