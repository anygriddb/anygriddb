import {
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@anygriddb/ui";
import {
  AlignLeft,
  CalendarDays,
  ChevronDown,
  Copy,
  FileText,
  GanttChart,
  Images,
  Kanban,
  Lock,
  LockOpen,
  Map as MapIcon,
  Pencil,
  Share2,
  Plus,
  Sheet,
  Trash2,
  User,
  type LucideIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "../../lib/trpc";
import type { Role, ViewItem } from "../../lib/types";
import { ConfirmDialog, PromptDialog } from "../shell/dialogs";
import { ShareDialog } from "./share-dialog";
import { useTrashActions, useTrashDays } from "../../lib/trash";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { raw } from "../../lib/known-text";

export const VIEW_ICONS: Record<string, LucideIcon> = {
  grid: Sheet,
  form: FileText,
  kanban: Kanban,
  gallery: Images,
  calendar: CalendarDays,
  timeline: GanttChart,
  map: MapIcon,
};

const VIEW_LABELS: Record<string, MessageDescriptor> = {
  grid: msg`Grid`,
  form: msg`Form`,
  kanban: msg`Kanban`,
  gallery: msg`Gallery`,
  calendar: msg`Calendar`,
  timeline: msg`Timeline`,
  map: msg`Map`,
};

type ViewType =
  "grid" | "form" | "kanban" | "gallery" | "calendar" | "timeline" | "map";

export function ViewTabs(props: {
  baseId: string;
  tableId: string;
  views: readonly ViewItem[];
  activeId: string | undefined;
  role: Role | null;
  userCanEditView: (view: ViewItem) => boolean;
  onChanged: () => Promise<unknown>;
  onCreated: (view: ViewItem) => void;
  className?: string;
}) {
  const { t } = useLingui();
  const days = useTrashDays();
  const errorText = useErrorText();
  const { trashed } = useTrashActions();
  const [renaming, setRenaming] = useState<ViewItem | null>(null);
  const [describing, setDescribing] = useState<ViewItem | null>(null);
  const [deleting, setDeleting] = useState<ViewItem | null>(null);
  const [sharing, setSharing] = useState<ViewItem | null>(null);
  const [creating, setCreating] = useState<{
    type: ViewType;
    personal: boolean;
  } | null>(null);
  const collaborative = props.role === "owner" || props.role === "editor";

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await props.onChanged();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  return (
    // Each view is a page of its own: links, the open one marked current.
    <nav
      className={cn(
        "flex min-w-0 items-stretch gap-3 overflow-x-auto px-1",
        props.className,
      )}
      aria-label={t`Views`}
    >
      {props.views.map((view) => {
        const Icon = VIEW_ICONS[view.viewType] ?? Sheet;
        const active = view.id === props.activeId;
        const editable = props.userCanEditView(view);
        return (
          <div
            key={view.id}
            className={cn(
              "group flex shrink-0 items-center gap-1 border-b-2 px-0.5 text-sm",
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Link
              aria-current={active ? "page" : undefined}
              to="/b/$baseId/t/$tableId/{-$viewId}"
              params={{
                baseId: props.baseId,
                tableId: props.tableId,
                viewId: view.id,
              }}
              className="flex items-center gap-1.5 py-2"
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              <span className="max-w-40 truncate">{view.name}</span>
              {view.personal ? (
                <User
                  className="h-3 w-3 opacity-60"
                  aria-label={t`Personal view`}
                />
              ) : null}
              {view.locked ? (
                <Lock
                  className="h-3 w-3 opacity-60"
                  aria-label={t`Locked view`}
                />
              ) : null}
            </Link>
            {active ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="rounded p-0.5 hover:bg-muted"
                  aria-label={t`View actions`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    disabled={!editable}
                    onSelect={() => setRenaming(view)}
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                    {t`Rename`}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!editable}
                    onSelect={() => setDescribing(view)}
                  >
                    <AlignLeft className="h-4 w-4" aria-hidden />
                    {t`Describe the view`}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void run(async () => {
                        const copy = await trpc.catalog.duplicateView.mutate({
                          viewId: view.id,
                        });
                        props.onCreated(copy);
                      })
                    }
                  >
                    <Copy className="h-4 w-4" aria-hidden />
                    {t`Duplicate`}
                  </DropdownMenuItem>
                  {props.role === "owner" && !view.personal ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        void run(() =>
                          trpc.catalog.updateView.mutate({
                            viewId: view.id,
                            locked: !view.locked,
                          }),
                        )
                      }
                    >
                      {view.locked ? (
                        <LockOpen className="h-4 w-4" aria-hidden />
                      ) : (
                        <Lock className="h-4 w-4" aria-hidden />
                      )}
                      {view.locked ? t`Unlock view` : t`Lock view`}
                    </DropdownMenuItem>
                  ) : null}
                  {collaborative && !view.personal ? (
                    <DropdownMenuItem onSelect={() => setSharing(view)}>
                      <Share2 className="h-4 w-4" aria-hidden />
                      {t`Share view`}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    danger
                    disabled={!editable}
                    onSelect={() => setDeleting(view)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                    {t`Delete view`}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`New view`}
          className="flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-4 w-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {/* A view is shared unless its author keeps it: asked when it
              is named, not by listing every type twice. */}
          {(Object.keys(VIEW_LABELS) as ViewType[]).map((type) => {
            const Icon = VIEW_ICONS[type] ?? Sheet;
            return (
              <DropdownMenuItem
                key={type}
                onSelect={() => setCreating({ type, personal: !collaborative })}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {t(VIEW_LABELS[type] ?? raw(type))}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {creating ? (
        <PromptDialog
          open
          onOpenChange={(open) => !open && setCreating(null)}
          title={creating.personal ? t`New personal view` : t`New view`}
          label={t`View name`}
          initial={t(VIEW_LABELS[creating.type] ?? raw(creating.type))}
          submitLabel={t`Create`}
          onSubmit={(name) =>
            run(async () => {
              const view = await trpc.catalog.createView.mutate({
                tableId: props.tableId,
                name,
                viewType: creating.type,
                personal: creating.personal,
              });
              props.onCreated(view);
            })
          }
        >
          {collaborative ? (
            <label className="mt-1 flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={creating.personal}
                onChange={(event) =>
                  setCreating({ ...creating, personal: event.target.checked })
                }
              />
              <span className="flex flex-col">
                {t`Personal view`}
                <span className="text-xs text-muted-foreground">
                  {t`Only you see it. Others keep the shared views.`}
                </span>
              </span>
            </label>
          ) : null}
        </PromptDialog>
      ) : null}
      {renaming ? (
        <PromptDialog
          open
          onOpenChange={(open) => !open && setRenaming(null)}
          title={t`Rename view`}
          label={t`View name`}
          initial={renaming.name}
          onSubmit={(name) =>
            run(() =>
              trpc.catalog.updateView.mutate({ viewId: renaming.id, name }),
            )
          }
        />
      ) : null}
      {describing ? (
        <PromptDialog
          open
          optional
          multiline
          onOpenChange={(open) => !open && setDescribing(null)}
          title={t`Describe the view`}
          label={t`What this view is for (empty: no description)`}
          initial={
            typeof describing.config.description === "string"
              ? describing.config.description
              : ""
          }
          onSubmit={(text) =>
            run(() =>
              trpc.catalog.updateView.mutate({
                viewId: describing.id,
                patch: { description: text || null },
              }),
            )
          }
        />
      ) : null}
      {sharing ? (
        <ShareDialog view={sharing} onClose={() => setSharing(null)} />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setDeleting(null)}
          title={t`Delete the view “${{ name: deleting.name }}”?`}
          description={t`The view goes to the base's trash for ${{ days }} days. The data is not touched.`}
          confirmLabel={t`Delete`}
          onConfirm={async () => {
            const view = deleting;
            // Set inside the callback: typed wide so the check below is kept.
            let done = false as boolean;
            await run(async () => {
              await trpc.catalog.deleteView.mutate({ viewId: view.id });
              done = true;
            });
            if (done) trashed(t`View moved to the trash`, "view", view.id);
          }}
        />
      ) : null}
    </nav>
  );
}
