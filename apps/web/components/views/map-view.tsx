import { decimalToNumber, parsePlace } from "@anygriddb/core";

import { Button, cn, Tooltip } from "@anygriddb/ui";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  MapPin,
  Minus,
  Plus,
  RotateCcw,
} from "lucide-react";
import type { RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

/** A press that moves less than this, in pixels, is a click, not a drag. */
const DRAG_START = 4;
/** What one notch of a mouse wheel scrolls, in pixels: a zoom step. */
const WHEEL_NOTCH = 100;
/** The share of the view one press of an arrow button moves it by. */
const PAN_STEP = 0.25;

/** One of the map's own buttons: an icon, named for everyone. */
function MapButton({
  label,
  disabled,
  onPress,
  className,
  children,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} side="left">
      <Button
        size="icon"
        variant="outline"
        className={className}
        aria-label={label}
        disabled={disabled}
        onClick={onPress}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

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
  const found = placeColumns(props.config, props.allColumns);
  const { places, numbers, place, latitude: lat, longitude: lon } = found;
  const notice = mapNotice(found);
  // The view reads only the rows that have a place, page after page, up
  // to the ceiling.
  const placed = Boolean(place) || Boolean(lat && lon);
  const shown = placed ? Math.min(props.total, MAP_CEILING) : 0;
  const { ensure } = props;
  useEffect(() => {
    if (shown > 0) ensure(0, shown - 1);
  }, [ensure, shown]);
  const points = props.rows.flatMap((row) => {
    if (place) {
      // A place field holds both, as it was checked when written.
      const value = row[place as keyof RowItem];
      const read = typeof value === "string" ? parsePlace(value) : undefined;
      return read ? [{ row, ...read }] : [];
    }
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
  const drag = useRef<{ x: number; y: number; moving: boolean } | null>(null);
  const wheel = useRef(0);
  // The sheet is drawn only once the table has fields to place rows by:
  // what watches it starts again when that changes.
  const drawn = notice !== "add-fields";
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const observer = new ResizeObserver((entries) => {
      const size = entries[0]?.contentRect;
      if (size && size.height > 0) setAspect(size.width / size.height);
    });
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [drawn]);
  // The sheet frames the rows' places, with a basemap under them or none:
  // drawn on the whole globe, the places of one region were one blot.
  const fitted = mapViewport(
    points.map(({ latitude, longitude }) => ({ latitude, longitude })),
    aspect,
  );
  const fittedKey = `${fitted.minX}:${fitted.maxX}:${fitted.minY}:${fitted.maxY}:${fitted.zoom}`;
  // A pan or zoom sticks until the person resets, or the fitted view moves
  // (its key changes and the manual offset no longer applies).
  const moved = manual && manual.key === fittedKey ? manual.viewport : null;
  const viewport = moved ?? fitted;
  const setView = (next: MapViewport) =>
    setManual({ key: fittedKey, viewport: next });
  const zoom = (delta: 1 | -1) => {
    setView(zoomViewport(viewport, delta, aspect));
  };
  const pan = (dx: number, dy: number) => {
    setView(panViewport(viewport, dx, dy));
  };
  // A trackpad sends many small scrolls where a mouse sends one notch:
  // they add up to a step, so that a swipe does not cross every zoom.
  const onWheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault();
    wheel.current +=
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        ? event.deltaY
        : event.deltaY * WHEEL_NOTCH;
    if (Math.abs(wheel.current) < WHEEL_NOTCH) return;
    zoom(wheel.current < 0 ? 1 : -1);
    wheel.current = 0;
  });
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    // React listens to the wheel passively, and a passive listener cannot
    // keep the page from scrolling under the map.
    sheet.addEventListener("wheel", onWheel, { passive: false });
    return () => sheet.removeEventListener("wheel", onWheel);
  }, [drawn]);
  const tiles = tileUrl ? mapTiles(tileUrl, viewport) : [];
  // Nothing to choose from: the map says what it needs, as the kanban and
  // the calendar do, rather than an empty sheet.
  if (notice === "add-fields") {
    return (
      <ViewSetupPrompt
        title={t`Add a place field, or two number fields for a latitude and a longitude, to place rows on the map.`}
        onAddField={props.onOpenFieldEditor}
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-1.5">
        {places.length > 0 ? (
          <ColumnPicker
            label={t`Place`}
            value={place}
            columns={places}
            // Without a place field, the map reads two numbers.
            allowNone={numbers.length >= 2}
            noneLabel={t`A latitude and a longitude`}
            onChange={(value) =>
              props.onPatch(
                value
                  ? {
                      placeColumn: value,
                      latitudeColumn: null,
                      longitudeColumn: null,
                    }
                  : {
                      placeColumn: null,
                      // Chosen, so that the first place field is not
                      // taken again: the ones found by name, or the
                      // first two numbers.
                      latitudeColumn:
                        numbers.find((column) => /lat/i.test(column.name))
                          ?.name ??
                        numbers[0]?.name ??
                        null,
                      longitudeColumn:
                        numbers.find((column) => /lon|lng/i.test(column.name))
                          ?.name ??
                        numbers[1]?.name ??
                        null,
                    },
              )
            }
          />
        ) : null}
        {place ? null : (
          <>
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
          </>
        )}
        <span className="text-xs text-muted-foreground">
          {notice === "choose-fields"
            ? t`Choose the fields that hold the latitude and the longitude.`
            : props.total > MAP_CEILING && placed
              ? t`The first ${{ shown: formatNumber(MAP_CEILING, locale) }} of ${{ total: formatNumber(props.total, locale) }} places`
              : plural(points.length, { one: `# point`, other: `# points` })}
        </span>
      </div>
      {/* On a narrow screen the map stands over its list, each as wide as
          the page: side by side, the list left the map a strip. */}
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <div
          ref={sheetRef}
          className={cn(
            "relative m-4 flex-1 cursor-grab touch-none overflow-hidden rounded-sm border border-border select-none max-md:m-2 max-md:h-64 max-md:flex-none",
            tileUrl
              ? "bg-muted"
              : "bg-[linear-gradient(transparent_49.5%,var(--ag-border)_50%,transparent_50.5%),linear-gradient(90deg,transparent_49.5%,var(--ag-border)_50%,transparent_50.5%)] bg-[size:12.5%_16.66%]",
          )}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              moving: false,
            };
          }}
          onPointerMove={(event) => {
            const from = drag.current;
            const sheet = event.currentTarget;
            if (!from || sheet.clientWidth === 0) return;
            const dx = from.x - event.clientX;
            const dy = from.y - event.clientY;
            // A press that barely moves stays a click, on a pin or
            // on a button. Once it drags, the sheet keeps the
            // pointer, and its release opens no pin.
            if (!from.moving && Math.hypot(dx, dy) < DRAG_START) return;
            if (!from.moving) sheet.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              moving: true,
            };
            pan(dx / sheet.clientWidth, dy / sheet.clientHeight);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          {points.length > 0 ? (
            // Every move the pointer makes has a button: the keyboard
            // reaches them, and a pointer that cannot drag presses them.
            <div
              role="group"
              aria-label={t`Move the map`}
              className="absolute top-2 right-2 z-20 grid grid-cols-3 gap-1"
            >
              <MapButton label={t`Zoom in`} onPress={() => zoom(1)}>
                <Plus className="h-4 w-4" aria-hidden />
              </MapButton>
              <MapButton
                label={t`Move north`}
                onPress={() => pan(0, -PAN_STEP)}
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
              </MapButton>
              <MapButton label={t`Zoom out`} onPress={() => zoom(-1)}>
                <Minus className="h-4 w-4" aria-hidden />
              </MapButton>
              <MapButton label={t`Move west`} onPress={() => pan(-PAN_STEP, 0)}>
                <ArrowLeft className="h-4 w-4" aria-hidden />
              </MapButton>
              <MapButton
                label={t`Reset the map`}
                disabled={!moved}
                onPress={() => setManual(null)}
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
              </MapButton>
              <MapButton label={t`Move east`} onPress={() => pan(PAN_STEP, 0)}>
                <ArrowRight className="h-4 w-4" aria-hidden />
              </MapButton>
              <MapButton
                label={t`Move south`}
                className="col-start-2"
                onPress={() => pan(0, PAN_STEP)}
              >
                <ArrowDown className="h-4 w-4" aria-hidden />
              </MapButton>
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
            const placeOnMap = pinPlace({ longitude, latitude }, viewport);
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
        <ul className="w-64 shrink-0 overflow-y-auto border-l border-border text-sm max-md:min-h-0 max-md:w-auto max-md:flex-1 max-md:border-t max-md:border-l-0">
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
