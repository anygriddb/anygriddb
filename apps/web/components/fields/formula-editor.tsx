/**
 * The formula editor (ADR 0021): CodeMirror 6 on the parser of
 * packages/core, the one the server runs. Fields and functions complete
 * as you type, and a formula that does not parse or type is underlined
 * where it fails. The server checks again when the field is saved.
 */
import {
  checkFormula,
  FORMULA_FNS,
  formulaLimits,
  formulaTokens,
  typeFormula,
  type DialectName,
  type FormulaRef,
  type FormulaTypeContext,
  type SourceLimit,
} from "@anygriddb/core";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { distinctLimits, useLimitText } from "../../lib/limits";
import { FORMULA_DOCS } from "./formula-docs";
import { LimitNotice } from "./limit-notice";

export type FormulaEditorHandle = {
  /**
   * Replaces the selection with `text`, and puts the cursor after it, or
   * `back` characters before its end (1 puts it inside `NAME()`).
   */
  insert: (text: string, options?: { back?: number }) => void;
};

const MARKS = {
  number: Decoration.mark({ class: "cm-f-number" }),
  string: Decoration.mark({ class: "cm-f-string" }),
  field: Decoration.mark({ class: "cm-f-field" }),
  function: Decoration.mark({ class: "cm-f-function" }),
  name: Decoration.mark({ class: "cm-f-name" }),
  operator: Decoration.mark({ class: "cm-f-operator" }),
  punctuation: Decoration.mark({ class: "cm-f-punctuation" }),
  invalid: Decoration.mark({ class: "cm-f-invalid" }),
};

function highlight(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const token of formulaTokens(view.state.doc.toString())) {
    if (token.to > token.from)
      builder.add(token.from, token.to, MARKS[token.kind]);
  }
  return builder.finish();
}

// Formulas are short (4,000 characters at most): tokenize all of it.
const highlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = highlight(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = highlight(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const theme = EditorView.theme({
  "&": {
    fontSize: "13px",
    border: "1px solid var(--color-border)",
    borderRadius: "6px",
    backgroundColor: "var(--color-card)",
    color: "var(--color-foreground)",
  },
  "&.cm-focused": {
    outline: "2px solid var(--color-ring, var(--color-primary))",
    outlineOffset: "1px",
  },
  ".cm-content": {
    minHeight: "8rem",
    padding: "6px 0",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    caretColor: "var(--color-foreground)",
  },
  ".cm-line": { padding: "0 8px" },
  ".cm-placeholder": { color: "var(--color-muted-foreground)" },
  ".cm-f-field": { color: "var(--color-primary)", fontWeight: "500" },
  ".cm-f-function": {
    color: "var(--color-accent-foreground)",
    fontWeight: "600",
  },
  ".cm-f-string": { color: "var(--color-danger)" },
  ".cm-f-number": { color: "var(--color-primary)" },
  ".cm-f-operator": { color: "var(--color-muted-foreground)" },
  ".cm-f-invalid": { textDecoration: "underline wavy var(--color-danger)" },
  ".cm-tooltip": {
    border: "1px solid var(--color-border)",
    backgroundColor: "var(--color-card)",
    borderRadius: "6px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--color-accent)",
    color: "var(--color-accent-foreground)",
  },
  // A function's sentence, then its example on a line of its own.
  ".cm-completionInfo": {
    whiteSpace: "pre-line",
    maxWidth: "18rem",
    padding: "4px 8px",
    fontSize: "12px",
  },
});

/**
 * Inserts `text` over the completed word, and over the closing character
 * that closeBrackets typed ahead of the cursor, so `{N` + `}` becomes
 * `{Nom}`, not `{Nom}}`. The cursor lands `back` characters before the end.
 */
function replaceWith(text: string, closing: string, back = 0) {
  return (editor: EditorView, _: Completion, from: number, to: number) => {
    const end = editor.state.sliceDoc(to, to + 1) === closing ? to + 1 : to;
    editor.dispatch({
      changes: { from, to: end, insert: text },
      selection: { anchor: from + text.length - back },
    });
  };
}

export default function FormulaEditor(props: {
  value: string;
  onChange: (value: string) => void;
  /** The fields a formula may read, by label. */
  refs: readonly FormulaRef[];
  label: string;
  describedBy?: string;
  handle?: Ref<FormulaEditorHandle>;
  /** The engine of a client's table: what it computes differently shows. */
  engine?: DialectName | undefined;
  /** Columns and engine for live type checking (shared with the server). */
  typeContext?: FormulaTypeContext | undefined;
  /**
   * What the server found when the formula was saved, types and the
   * fields it reads included: shown while the text is the saved one.
   */
  saved?: { source: string; limits: readonly SourceLimit[] } | undefined;
}) {
  const errorText = useErrorText();
  const limitText = useLimitText();
  const { i18n } = useLingui();
  const host = useRef<HTMLDivElement>(null);
  const statusId = useId();
  const limitsId = useId();
  // The problem as text under the editor: a screen reader hears it, and
  // nobody has to hover the underline to read it.
  const [problem, setProblem] = useState("");
  const [limits, setLimits] = useState<string[]>([]);
  const view = useRef<EditorView | null>(null);
  const changed = useEffectEvent((value: string) => props.onChange(value));
  const current = useEffectEvent(() => ({
    refs: props.refs,
    errorText,
    engine: props.engine,
    typeContext: props.typeContext,
    saved: props.saved,
    limitText,
    say: (descriptor: MessageDescriptor) => i18n._(descriptor),
  }));

  useImperativeHandle(props.handle, () => ({
    insert(text: string, options?: { back?: number }) {
      const editor = view.current;
      if (!editor) return;
      const { from, to } = editor.state.selection.main;
      editor.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length - (options?.back ?? 0) },
      });
      editor.focus();
    },
  }));

  // One editor for the life of the component; the latest props are read
  // through effect events.
  useEffect(() => {
    if (!host.current) return;
    const complete = (context: CompletionContext): CompletionResult | null => {
      const field = context.matchBefore(/\{[^{}]*/);
      if (field) {
        return {
          from: field.from,
          options: current().refs.map((ref) => ({
            label: `{${ref.label}}`,
            type: "variable",
            apply: replaceWith(`{${ref.label}}`, "}"),
          })),
          validFor: /^\{[^{}]*$/,
        };
      }
      const word = context.matchBefore(/[\p{L}_][\p{L}\p{N}_]*/u);
      if (!word || (word.from === word.to && !context.explicit)) return null;
      const { say } = current();
      return {
        from: word.from,
        options: FORMULA_FNS.map((fn) => {
          const doc = FORMULA_DOCS[fn];
          return {
            label: fn.toUpperCase(),
            type: "function",
            detail: say(doc.args),
            info: `${say(doc.summary)}\n${doc.example}`,
            // `ROUND()`, the cursor between the parentheses.
            apply: replaceWith(`${fn.toUpperCase()}()`, "(", 1),
          };
        }),
        validFor: /^[\p{L}_][\p{L}\p{N}_]*$/u,
      };
    };
    const lint = (editor: EditorView): Diagnostic[] => {
      const source = editor.state.doc.toString();
      const {
        refs,
        errorText: describe,
        engine,
        typeContext,
        saved,
        limitText: say,
      } = current();
      let found = source.trim() === "" ? null : checkFormula(source, refs);
      let fromTyped: SourceLimit[] = [];
      if (!found && source.trim() !== "" && typeContext) {
        const typed = typeFormula(source, refs, typeContext);
        if ("kind" in typed) fromTyped = typed.limits;
        else found = typed;
      }
      const message = found ? describe(found) : "";
      setProblem(message);
      // What the engine computes differently, marked where it is written.
      const limited = engine ? formulaLimits(source, engine) : [];
      const known = saved?.source === source ? saved.limits : [];
      setLimits(distinctLimits([...limited, ...fromTyped, ...known]).map(say));
      const warnings = limited.map((limit): Diagnostic => ({
        from: limit.from,
        to: limit.to,
        severity: "warning",
        message: say(limit),
      }));
      if (!found) return warnings;
      return [
        {
          from: Math.min(found.from, source.length),
          to: Math.min(Math.max(found.to, found.from), source.length),
          severity: "error",
          message,
        },
        ...warnings,
      ];
    };
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          closeBrackets(),
          bracketMatching(),
          highlighting,
          autocompletion({ override: [complete], icons: false }),
          linter(lint, { delay: 250 }),
          // Tab leaves the editor, as in any form field.
          keymap.of([
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          // Escape closes a completion list, not the dialog around it.
          EditorView.domEventHandlers({
            keydown(event, target) {
              if (
                event.key === "Escape" &&
                completionStatus(target.state) !== null
              ) {
                event.stopPropagation();
              }
              return false;
            },
          }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": props.label,
            "aria-describedby": [props.describedBy, statusId, limitsId]
              .filter(Boolean)
              .join(" "),
          }),
          placeholder("{Prix} * {Quantité}"),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed(update.state.doc.toString());
          }),
          theme,
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor is created once; later props arrive through effect events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A value set from outside (a reset) replaces the text.
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === props.value) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: props.value },
    });
  }, [props.value]);

  return (
    <div className="flex flex-col gap-1">
      <div ref={host} data-testid="formula-editor" />
      <p id={statusId} role="status" className="min-h-4 text-xs text-danger">
        {problem}
      </p>
      <LimitNotice id={limitsId} texts={limits} />
    </div>
  );
}
