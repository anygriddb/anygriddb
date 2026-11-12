import { decimalToNumber } from "@anygriddb/core";

import { cn } from "@anygriddb/ui";
import { MapPin } from "lucide-react";
import type { RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import { useEffect } from "react";
import { formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { MAP_CEILING, placeColumns } from "./map-places";
import { ColumnPicker, useRowTitle, type ViewProps } from "./view-common";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

export function MapView(props: ViewProps) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const table = useTable();
  const title = useRowTitle(
    typeof props.config.titleColumn === "string"
      ? props.config.titleColumn
      : undefined,
  );
  const {
    numbers,
    latitude: lat,
    longitude: lon,
  } = placeColumns(props.config, props.allColumns);
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
          {props.total > MAP_CEILING && lat && lon
            ? t`The first ${{ shown: formatNumber(MAP_CEILING, locale) }} of ${{ total: formatNumber(props.total, locale) }} places`
            : plural(points.length, { one: `# point`, other: `# points` })}
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative m-4 flex-1 overflow-hidden rounded-sm border border-border bg-[linear-gradient(transparent_49.5%,var(--ag-border)_50%,transparent_50.5%),linear-gradient(90deg,transparent_49.5%,var(--ag-border)_50%,transparent_50.5%)] bg-[size:12.5%_16.66%]">
          {/* The pins are for a pointer: close places overlap. The list
              beside them opens the same rows, by keyboard and to a screen
              reader, however close they are. */}
          {points.map(({ row, latitude, longitude }) => {
            const tint = props.tintOf?.(row);
            return (
              <span
                key={row.id}
                aria-hidden
                title={title(row)}
                onClick={() => table.openRecord(row.id)}
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-full cursor-pointer",
                  tint ? `opt-${tint} bg-transparent` : "text-primary",
                )}
                style={{
                  left: `${((longitude + 180) / 360) * 100}%`,
                  top: `${((90 - latitude) / 180) * 100}%`,
                }}
              >
                <MapPin className="h-5 w-5 fill-current" />
              </span>
            );
          })}
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
