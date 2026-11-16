/**
 * The editor of an automation's script (ADR 0099): CodeMirror 6 with the
 * JavaScript grammar, so the text is coloured, its brackets matched, and
 * a new line indented as the one before. It is loaded with the first
 * script a person opens. What is typed is the script: nothing is checked
 * here, the script's own process reports what fails when it runs.
 */
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useEffectEvent, useRef } from "react";

// The colours of the formula editor, for the same kinds of words.
const colours = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword],
    color: "var(--color-accent-foreground)",
    fontWeight: "600",
  },
  { tag: [tags.string, tags.regexp], color: "var(--color-danger)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--color-primary)" },
  {
    tag: [tags.comment],
    color: "var(--color-muted-foreground)",
    fontStyle: "italic",
  },
  {
    tag: [tags.operator, tags.punctuation],
    color: "var(--color-muted-foreground)",
  },
  { tag: tags.propertyName, color: "var(--color-foreground)" },
]);

const theme = EditorView.theme({
  "&": {
    fontSize: "12px",
    border: "1px solid var(--color-border)",
    borderRadius: "6px",
    backgroundColor: "var(--color-card)",
    color: "var(--color-foreground)",
  },
  "&.cm-focused": {
    outline: "2px solid var(--color-ring, var(--color-primary))",
    outlineOffset: "1px",
  },
  ".cm-scroller": {
    minHeight: "12rem",
    maxHeight: "24rem",
    overflow: "auto",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  },
  ".cm-content": {
    padding: "6px 0",
    caretColor: "var(--color-foreground)",
  },
  ".cm-line": { padding: "0 8px" },
  ".cm-gutters": {
    backgroundColor: "var(--color-muted)",
    color: "var(--color-muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--color-border)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "var(--color-accent)",
    outline: "none",
  },
});

export default function ScriptCodeEditor(props: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  describedBy?: string;
  /** The longest script the server takes: nothing is typed past it. */
  maxLength: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changed = useEffectEvent((value: string) => props.onChange(value));

  // One editor for the life of the component; the latest props are read
  // through effect events.
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(),
          history(),
          javascript(),
          syntaxHighlighting(colours),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          indentUnit.of("  "),
          EditorState.tabSize.of(2),
          // Tab leaves the editor, as in any form field: a new line is
          // indented as the one before it.
          keymap.of([
            ...closeBracketsKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          // What would make the script longer than it may be is not typed.
          EditorState.changeFilter.of(
            (transaction) => transaction.newDoc.length <= props.maxLength,
          ),
          EditorView.contentAttributes.of({
            "aria-label": props.label,
            ...(props.describedBy
              ? { "aria-describedby": props.describedBy }
              : {}),
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
          }),
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

  // A value set from outside (another action chosen) replaces the text.
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === props.value) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: props.value },
    });
  }, [props.value]);

  return <div ref={host} data-testid="script-editor" />;
}
