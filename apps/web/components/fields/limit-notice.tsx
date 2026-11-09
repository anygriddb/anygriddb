import { TriangleAlert } from "lucide-react";

/**
 * What the client's engine computes differently, under the field being
 * built: the field works, and the person knows what to expect of it.
 */
export function LimitNotice(props: { id?: string; texts: readonly string[] }) {
  if (props.texts.length === 0) return null;
  return (
    <div
      id={props.id}
      className="flex gap-2 rounded-md border border-warning/40 bg-warning-surface p-2 text-xs"
    >
      <TriangleAlert
        className="mt-px h-3.5 w-3.5 shrink-0 text-warning"
        aria-hidden
      />
      <ul className="flex flex-col gap-1">
        {props.texts.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  );
}
