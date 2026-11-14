import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { encode } from "uqr";
import { code128 } from "../../lib/code128";
import { qrPath } from "../../lib/qr-path";

/** Past this, a QR code's modules are too fine to scan from a screen. */
const QR_MAX_CHARS = 500;
/** The quiet zone each side of a barcode, in modules. */
const BARCODE_QUIET = 10;

function qrModules(text: string): boolean[][] | null {
  if (text.length === 0 || text.length > QR_MAX_CHARS) return null;
  try {
    return encode(text, { ecc: "M", border: 2 }).data;
  } catch {
    // More than a code holds at this correction level.
    return null;
  }
}

/** A barcode's bars as one path, a module wide each, in a box one high. */
function barsPath(modules: readonly boolean[]): string {
  const parts: string[] = [];
  let x = 0;
  while (x < modules.length) {
    if (!modules[x]) {
      x += 1;
      continue;
    }
    const start = x;
    while (x < modules.length && modules[x]) x += 1;
    parts.push(`M${start + BARCODE_QUIET} 0h${x - start}v1h${start - x}z`);
  }
  return parts.join("");
}

/**
 * A text drawn as a QR code or a Code 128 barcode, black on white whatever
 * the theme, since a scanner reads contrast. Named by what it holds. A
 * text the code cannot hold is said, not drawn wrong.
 */
export function CodeImage({
  kind,
  text,
}: {
  kind: "qr" | "barcode";
  text: string;
}) {
  const { t } = useLingui();
  const qr = useMemo(
    () => (kind === "qr" ? qrModules(text) : null),
    [kind, text],
  );
  const bars = useMemo(
    () => (kind === "barcode" ? code128(text) : null),
    [kind, text],
  );
  if (kind === "qr") {
    if (!qr) {
      return (
        <span className="text-xs text-muted-foreground">
          {t`Too long to draw as a QR code`}
        </span>
      );
    }
    return (
      <svg
        role="img"
        aria-label={t`QR code of ${{ value: text }}`}
        viewBox={`0 0 ${qr.length} ${qr.length}`}
        shapeRendering="crispEdges"
        className="h-36 w-36 shrink-0 rounded-sm border border-border bg-white"
      >
        <path d={qrPath(qr)} className="fill-black" />
      </svg>
    );
  }
  if (!bars) {
    return (
      <span className="text-xs text-muted-foreground">
        {t`A barcode draws up to 80 letters, digits, and signs, without accents`}
      </span>
    );
  }
  const width = bars.length + 2 * BARCODE_QUIET;
  return (
    <svg
      role="img"
      aria-label={t`Barcode of ${{ value: text }}`}
      viewBox={`0 0 ${width} 1`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      // Two pixels a module, narrower only where the panel is.
      style={{ width: `${width * 2}px` }}
      className="h-14 max-w-full shrink-0 rounded-sm border border-border bg-white"
    >
      <path d={barsPath(bars)} className="fill-black" />
    </svg>
  );
}
