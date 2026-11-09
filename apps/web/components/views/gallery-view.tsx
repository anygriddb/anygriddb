import { Paperclip, Plus } from "lucide-react";
import { attachmentList } from "../../lib/format";
import type { RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import {
  CardFields,
  cardColumns,
  ColumnPicker,
  useRowTitle,
  type ViewProps,
} from "./view-common";
import { useLingui } from "@lingui/react/macro";

export function GalleryView(props: ViewProps) {
  const { t } = useLingui();
  const table = useTable();
  const title = useRowTitle();
  const attachments = props.allColumns.filter(
    (column) => column.fieldType === "attachment",
  );
  const cover =
    typeof props.config.coverColumn === "string"
      ? props.config.coverColumn
      : undefined;
  const fields = cardColumns(props.config, props.columns, cover ? [cover] : []);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-4 border-b border-border px-4 py-1.5">
        <ColumnPicker
          label={t`Cover`}
          value={cover}
          columns={attachments}
          allowNone
          onChange={(value) => props.onPatch({ coverColumn: value })}
        />
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4 overflow-y-auto p-4">
        {props.rows.map((row) => {
          const files = attachmentList(
            cover ? row[cover as keyof RowItem] : undefined,
          );
          const image = files.find((file) => file.thumb);
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => table.openRecord(row.id)}
              className="flex flex-col overflow-hidden rounded-sm border border-border bg-card text-left hover:border-strong-border"
            >
              {cover ? (
                <div className="flex h-36 items-center justify-center overflow-hidden bg-muted text-muted-foreground">
                  {image ? (
                    <img
                      src={`/api/attachments/${image.key}/thumb`}
                      alt={image.filename}
                      loading="lazy"
                      className={
                        props.config.coverFit === "contain"
                          ? "h-full w-full object-contain"
                          : "h-full w-full object-cover"
                      }
                    />
                  ) : (
                    <>
                      <Paperclip className="h-5 w-5" aria-hidden />
                      {files.length > 0 ? (
                        <span className="ml-1 text-xs">{files.length}</span>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
              <div className="p-3">
                <p className="truncate font-medium">{title(row)}</p>
                <CardFields row={row} columns={fields} />
              </div>
            </button>
          );
        })}
        {props.canEdit ? (
          <button
            type="button"
            onClick={() =>
              void props.onCreate({}).then((id) => id && table.openRecord(id))
            }
            className="flex min-h-32 items-center justify-center gap-1 rounded-sm border border-dashed border-border text-sm text-muted-foreground hover:bg-muted"
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t`Add a record`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
