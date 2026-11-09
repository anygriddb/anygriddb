import { mentionMarkup, mentionSegments } from "@anygriddb/core";
import { Avatar, cn, Textarea } from "@anygriddb/ui";
import { useId, useRef, useState, type ComponentProps } from "react";
import { useLingui } from "@lingui/react/macro";
import type { Collaborator } from "../../lib/types";

/** The `@query` being typed just before the caret, if any. */
export function mentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@[\]()]{0,30})$/u.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: before.length - query.length - 1, query };
}

/** A textarea that offers collaborators after `@` and inserts mention markup. */
export function MentionTextarea({
  value,
  onValueChange,
  people,
  className,
  onKeyDown,
  ...props
}: Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  people: ReadonlyMap<string, Collaborator>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [active, setActive] = useState(0);
  const { t } = useLingui();
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;
  const matches = query
    ? [...people.values()]
        .filter((person) =>
          person.displayName.toLowerCase().includes(query.query.toLowerCase()),
        )
        .slice(0, 6)
    : [];

  function track(text: string, caret: number) {
    setQuery(mentionQuery(text, caret));
    setActive(0);
  }

  function pick(person: Collaborator) {
    if (!query) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const markup = `${mentionMarkup(person.displayName, person.id)} `;
    const next = value.slice(0, query.start) + markup + value.slice(caret);
    onValueChange(next);
    setQuery(null);
    const position = query.start + markup.length;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(position, position);
    });
  }

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        className={className}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
          track(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={(event) => {
          if (matches.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive(
                (current) => (current + step + matches.length) % matches.length,
              );
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              const person = matches[active];
              if (person) pick(person);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setQuery(null);
              return;
            }
          }
          onKeyDown?.(event);
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        // The suggestions are named from the field: the arrows move
        // through them, Enter or Tab inserts the one announced.
        aria-autocomplete="list"
        aria-controls={matches.length > 0 ? listId : undefined}
        aria-activedescendant={
          matches.length > 0 ? optionId(active) : undefined
        }
        {...props}
      />
      {matches.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t`People to mention`}
          className="absolute bottom-full left-0 z-30 mb-1 w-64 overflow-hidden rounded-md border border-border bg-card shadow-lg"
        >
          {matches.map((person, index) => (
            <li
              key={person.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(person);
              }}
              className={cn(
                "flex w-full cursor-default items-center gap-2 px-2 py-1.5 text-left text-sm",
                index === active ? "bg-accent" : "hover:bg-muted",
              )}
            >
              <Avatar name={person.displayName} />
              {person.displayName}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Comment text with mentions shown as chips. */
export function CommentBody({ body }: { body: string }) {
  return (
    <>
      {mentionSegments(body).map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span
            key={index}
            className="rounded bg-accent px-1 font-medium text-accent-foreground"
          >
            @{segment.name}
          </span>
        ),
      )}
    </>
  );
}
