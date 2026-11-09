import { decimalToNumber } from "@anygriddb/core";

import { MapPin } from "lucide-react";
import type { RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import { ColumnPicker, useRowTitle, type ViewProps } from "./view-common";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

export function MapView(props: ViewProps) {
  const { t } = useLingui();
  const table = useTable();
  const title = useRowTitle();
  const numbers = props.allColumns.filter((column) => column.kind === "number");
  const lat =
    typeof props.config.latitudeColumn === "string"
      ? props.config.latitudeColumn
      : numbers.find((column) => /lat/i.test(column.name))?.name;
  const lon =
    typeof props.config.longitudeColumn === "string"
      ? props.config.longitudeColumn
      : numbers.find((column) => /lon|lng/i.test(column.name))?.name;
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
          {plural(points.length, { one: `# point`, other: `# points` })}
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative m-4 flex-1 overflow-hidden rounded-sm border border-border bg-[linear-gradient(transparent_49.5%,var(--ag-border)_50%,transparent_50.5%),linear-gradient(90deg,transparent_49.5%,var(--ag-border)_50%,transparent_50.5%)] bg-[size:12.5%_16.66%]">
          {points.map(({ row, latitude, longitude }) => (
            <button
              key={row.id}
              type="button"
              title={title(row)}
              onClick={() => table.openRecord(row.id)}
              className="absolute -translate-x-1/2 -translate-y-full text-primary"
              style={{
                left: `${((longitude + 180) / 360) * 100}%`,
                top: `${((90 - latitude) / 180) * 100}%`,
              }}
            >
              <MapPin className="h-5 w-5 fill-current" aria-hidden />
            </button>
          ))}
        </div>
        <ul className="w-64 shrink-0 overflow-y-auto border-l border-border text-sm">
          {points.map(({ row, latitude, longitude }) => (
            <li key={row.id} className="border-b border-border px-3 py-2">
              <button
                type="button"
                className="font-medium hover:underline"
                onClick={() => table.openRecord(row.id)}
              >
                {title(row)}
              </button>
              <a
                className="block text-xs text-primary"
                href={`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=12/${latitude}/${longitude}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {latitude.toFixed(4)}, {longitude.toFixed(4)}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
