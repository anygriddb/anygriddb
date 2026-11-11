import { cn } from "@anygriddb/ui";
import {
  useResizeHandle,
  type ResizeBounds,
  type ResizePhase,
} from "../../lib/resize-handle";

/** The strip on the right edge of a panel or a column that resizes it. */
export function ResizeHandle(props: {
  width: number;
  bounds: ResizeBounds;
  label: string;
  /** Focusable, moved by the arrows; off where the grid owns the keys. */
  keyboard?: boolean;
  onResize: (width: number, phase: ResizePhase) => void;
}) {
  const handle = useResizeHandle(props);
  return (
    <span
      {...handle}
      className={cn(
        "absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize touch-none hover:bg-primary/40",
        props.keyboard &&
          "outline-none focus-visible:bg-primary/60 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    />
  );
}
