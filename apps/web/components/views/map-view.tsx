import { decimalToNumber } from "@anygriddb/core";

import { Button, cn } from "@anygriddb/ui";
import { MapPin, Minus, Plus, RotateCcw } from "lucide-react";
import type { RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import { useEffect, useRef, useState } from "react";
import { formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { MAP_CEILING, mapNotice, placeColumns } from "./map-places";
import {
  mapTiles,
  mapViewport,
  panViewport,
  pinPlace,
  zoomViewport,
  type MapViewport,
} from "./map-tiles";
import {
  ColumnPicker,
  useRowTitle,
  ViewSetupPrompt,
  type ViewProps,
} from "./view-common";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc";

export function MapView(props: ViewProps) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const table = useTable();
  const api = useTRPC();
  const instance = useQuery(api.auth.instance.queryOptions());
  // The basemap an administrator set (ADR 0068); without one, the plain
  // projection.
  const tileUrl = instance.data?.mapTileUrl ?? null;
  const tileCredit = instance.data?.mapTileCredit ?? null;
  const title = useRowTitle(
    typeof props.config.titleColumn === "string"
      ? props.config.titleColumn
      : undefined,
  );
  const place = placeColumns(props.config, props.allColumns);
  const { numbers, latitude: lat, longitude: lon } = place;
  const notice = mapNotice(place);
  // The view reads only the rows that have a place, page after page, up
  // to the ceiling.
  const shown = lat && lon ? Math.min(props.total, MAP_CEILING) : 0;
  const { ensure } = props;
  useEffect(() => {
    if (shown > 0) ensure(0, shown - 1);
  }, [ensure, shown]);
  const points = props.rows.flatMap((row) => {
    // Coordinates come as exact decimals; a pin needs a float.
    const latitude = lat
      ? decimalToNumber(row[lat as keyof RowItem])
      : undefined;
    const longitude = lon
      ? decimalToNumber(row[lon as keyof RowItem])
      : undefined;
    return latitude !== undefined &&
      longitude !== undefined &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
      ? [{ row, latitude, longitude }]
      : [];
  });
  const sheetRef = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(1.5);
  const [manual, setManual] = useState<{
    key: string;
    viewport: MapViewport;
  } | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || !tileUrl) return;
    const observer = new ResizeObserver((entries) => {
      const size = entries[0]?.contentRect;
      if (size && size.height > 0) setAspect(size.width / size.height);
    });
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [tileUrl]);
  const fitted = tileUrl
    ? mapViewport(
        points.map(({ latitude, longitude }) => ({ latitude, longitude })),
        aspect,
      )
    : null;
  const fittedKey = fitted
    ? `${fitted.minX}:${fitted.maxX}:${fitted.minY}:${fitted.maxY}:${fitted.zoom}`
    : "";
  const setView = (next: MapViewport) =>
    setManual({ key: fittedKey, viewport: next });
  // A pan or zoom sticks until the person resets, or the fitted view moves
  // (its key changes and the manual offset no longer applies).
  const viewport =
    manual && manual.key === fittedKey ? manual.viewport : fitted;
  const tiles = tileUrl && viewport ? mapTiles(tileUrl, viewport) : [];
  // Nothing to choose from: the map says what it needs, as the kanban and
  // the calendar do, rather than an empty sheet.
  if (notice === "add-fields") {
    return (
      <ViewSetupPrompt
        title={t`Add two number fields, a latitude and a longitude, to place rows on the map.`}
        onAddField={props.onOpenFieldEditor}
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-1.5">
        <ColumnPicker
          label={t`Latitude`}
          value={lat}
          columns={numbers}
          onChange={(value) => props.onPatch({ latitudeColumn: value })}
        />
        <ColumnPicker
          label={t`Longitude`}
          value={lon}
          columns={numbers}
          onChange={(value) => props.onPatch({ longitudeColumn: value })}
        />
        <span className="text-xs text-muted-foreground">
          {notice === "choose-fields"
            ? t`Choose the fields that hold the latitude and the longitude.`
            : props.total > MAP_CEILING && lat && lon
              ? t`The first ${{ shown: formatNumber(MAP_CEILING, locale) }} of ${{ total: formatNumber(props.total, locale) }} places`
              : plural(points.length, { one: `# point`, other: `# points` })}
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          ref={sheetRef}
          className={cn(
            "relative m-4 flex-1 overflow-hidden rounded-sm border border-border",
            tileUrl
              ? "bg-muted"
              : "bg-[linear-gradient(transparent_49.5%,var(--ag-border)_50%,transparent_50.5%),linear-gradient(90deg,transparent_49.5%,var(--ag-border)_50%,transparent_50.5%)] bg-[size:12.5%_16.66%]",
          )}
          onWheel={
            tileUrl && viewport
              ? (event) => {
                  event.preventDefault();
                  setView(
                    zoomViewport(viewport, event.deltaY < 0 ? 1 : -1, aspect),
                  );
                }
              : undefined
          }
          onPointerDown={
            tileUrl
              ? (event) => {
                  if (event.button !== 0) return;
                  drag.current = { x: event.clientX, y: event.clientY };
                  (event.currentTarget as HTMLElement).setPointerCapture(
                    event.pointerId,
                  );
                }
              : undefined
          }
          onPointerMove={
            tileUrl && viewport
              ? (event) => {
                  if (!drag.current) return;
                  const sheet = sheetRef.current;
                  if (!sheet || sheet.clientWidth === 0) return;
                  const dx =
                    (drag.current.x - event.clientX) / sheet.clientWidth;
                  const dy =
                    (drag.current.y - event.clientY) / sheet.clientHeight;
                  drag.current = { x: event.clientX, y: event.clientY };
                  setView(panViewport(viewport, dx, dy));
                }
              : undefined
          }
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          {tileUrl && viewport ? (
            <div className="absolute top-2 right-2 z-20 flex flex-col gap-1">
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8 bg-card"
                aria-label={t`Zoom in`}
                onClick={() => setView(zoomViewport(viewport, 1, aspect))}
              >
                <Plus className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8 bg-card"
                aria-label={t`Zoom out`}
                onClick={() => setView(zoomViewport(viewport, -1, aspect))}
              >
                <Minus className="h-4 w-4" aria-hidden />
              </Button>
              {manual ? (
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8 bg-card"
                  aria-label={t`Reset the map`}
                  onClick={() => setManual(null)}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
            </div>
          ) : null}
          {tiles.map((tile) => (
            <img
              key={tile.key}
              src={tile.url}
              alt=""
              aria-hidden
              draggable={false}
              referrerPolicy="no-referrer"
              className="pointer-events-none absolute max-w-none select-none"
              style={{
                left: `${tile.left}%`,
                top: `${tile.top}%`,
                width: `${tile.width}%`,
                height: `${tile.height}%`,
              }}
            />
          ))}
          {/* The pins are for a pointer: close places overlap. The list
              beside them opens the same rows, by keyboard and to a screen
              reader, however close they are. */}
          {points.map(({ row, latitude, longitude }) => {
            const tint = props.tintOf?.(row);
            const placeOnMap = viewport
              ? pinPlace({ longitude, latitude }, viewport)
              : {
                  left: ((longitude + 180) / 360) * 100,
                  top: ((90 - latitude) / 180) * 100,
                };
            return (
              <span
                key={row.id}
                aria-hidden
                title={title(row)}
                onClick={() => table.openRecord(row.id)}
                className={cn(
                  "absolute z-10 -translate-x-1/2 -translate-y-full cursor-pointer",
                  tint ? `opt-${tint} bg-transparent` : "text-primary",
                )}
                style={{
                  left: `${placeOnMap.left}%`,
                  top: `${placeOnMap.top}%`,
                }}
              >
                <MapPin className="h-5 w-5 fill-current drop-shadow-sm" />
              </span>
            );
          })}
          {tileUrl && tileCredit ? (
            <p className="absolute bottom-0 right-0 z-10 bg-background/85 px-1.5 py-0.5 text-[11px] text-foreground">
              {tileCredit}
            </p>
          ) : null}
        </div>
        <ul className="w-64 shrink-0 overflow-y-auto border-l border-border text-sm">
          {points.map(({ row, latitude, longitude }) => {
            const tint = props.tintOf?.(row);
            return (
              <li
                key={row.id}
                className={cn(
                  "border-b border-border px-3 py-2",
                  tint && `row-tint-${tint}`,
                )}
              >
                <button
                  type="button"
                  className="block min-h-6 w-full text-left font-medium hover:underline"
                  onClick={() => table.openRecord(row.id)}
                >
                  {title(row)}
                </button>
                <a
                  className="flex min-h-6 items-center text-xs text-primary"
                  href={`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=12/${latitude}/${longitude}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {latitude.toFixed(4)}, {longitude.toFixed(4)}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
