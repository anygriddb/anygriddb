import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
} from "@anygriddb/ui";
import {
  Database,
  LayoutDashboard,
  Moon,
  Settings,
  Sun,
  Table2,
  Users,
} from "lucide-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCatalog } from "../../lib/session";
import { canManage } from "../../lib/types";
import { useTheme } from "../../lib/theme";
import { useLingui } from "@lingui/react/macro";
import { useAdminSections } from "../admin/admin-sections";

const OPEN_EVENT = "ag:command-palette";

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function CommandPalette() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const adminSections = useAdminSections();
  // The base on screen, for its settings and dashboards.
  const { baseId } = useParams({ strict: false });
  const base = (catalog.data ?? []).find((item) => item.id === baseId);
  const { setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);
  /** Closes the palette, then runs the navigation it was opened for. */
  const go = (navigation: () => Promise<void>) => {
    setOpen(false);
    void navigation();
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={t`Go to…`} className="[&>div:last-child]:p-0">
        <Command loop>
          <CommandInput placeholder={t`Table, base, or action`} autoFocus />
          <CommandList>
            <CommandEmpty>
              <span className="block px-2 py-4 text-sm">
                <span className="font-medium text-foreground">
                  {t`No results`}
                </span>
                <span className="mt-1 block text-muted-foreground">
                  {t`Try another table or base name, or open a recent one from home.`}
                </span>
              </span>
            </CommandEmpty>
            <CommandGroup heading={t`Tables`}>
              {(catalog.data ?? []).flatMap((base) =>
                base.tables.map((table) => (
                  <CommandItem
                    key={table.id}
                    value={`${base.name} ${table.name}`}
                    onSelect={() =>
                      go(() =>
                        navigate({
                          to: "/b/$baseId/t/$tableId/{-$viewId}",
                          params: { baseId: base.id, tableId: table.id },
                        }),
                      )
                    }
                  >
                    <Table2 className="h-4 w-4 opacity-70" aria-hidden />
                    <span>{table.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {base.name}
                    </span>
                  </CommandItem>
                )),
              )}
            </CommandGroup>
            <CommandGroup heading={t`Bases`}>
              {(catalog.data ?? []).map((base) => (
                <CommandItem
                  key={base.id}
                  value={`base ${base.name}`}
                  onSelect={() =>
                    go(() =>
                      navigate({
                        to: "/b/$baseId",
                        params: { baseId: base.id },
                      }),
                    )
                  }
                >
                  <Database className="h-4 w-4 opacity-70" aria-hidden />
                  {base.name}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading={t`Actions`}>
              <CommandItem
                value="settings réglages"
                onSelect={() => go(() => navigate({ to: "/settings" }))}
              >
                <Settings className="h-4 w-4 opacity-70" aria-hidden />
                {t`Account settings`}
              </CommandItem>
              {base ? (
                <CommandItem
                  value={`dashboards tableaux de bord ${base.name}`}
                  onSelect={() =>
                    go(() =>
                      navigate({
                        to: "/b/$baseId/dashboards",
                        params: { baseId: base.id },
                      }),
                    )
                  }
                >
                  <LayoutDashboard className="h-4 w-4 opacity-70" aria-hidden />
                  {t`Dashboards of ${{ name: base.name }}`}
                </CommandItem>
              ) : null}
              {base && canManage(base.role) ? (
                <CommandItem
                  value={`members access accès membres ${base.name}`}
                  onSelect={() =>
                    go(() =>
                      navigate({
                        to: "/b/$baseId/settings",
                        params: { baseId: base.id },
                      }),
                    )
                  }
                >
                  <Users className="h-4 w-4 opacity-70" aria-hidden />
                  {t`Members and access of ${{ name: base.name }}`}
                </CommandItem>
              ) : null}
              <CommandItem
                value="theme dark sombre"
                onSelect={() => {
                  setTheme("dark");
                  setOpen(false);
                }}
              >
                <Moon className="h-4 w-4 opacity-70" aria-hidden />
                {t`Dark theme`}
              </CommandItem>
              <CommandItem
                value="theme light clair"
                onSelect={() => {
                  setTheme("light");
                  setOpen(false);
                }}
              >
                <Sun className="h-4 w-4 opacity-70" aria-hidden />
                {t`Light theme`}
              </CommandItem>
            </CommandGroup>
            {adminSections.length > 0 ? (
              <CommandGroup heading={t`Administration`}>
                {adminSections.flatMap((section) =>
                  section.pages.map((page) => (
                    <CommandItem
                      key={page.to}
                      value={`administration admin ${section.label} ${page.label}`}
                      onSelect={() => go(() => navigate({ to: page.to }))}
                    >
                      <section.icon
                        className="h-4 w-4 opacity-70"
                        aria-hidden
                      />
                      {section.pages.length > 1
                        ? `${section.label} · ${page.label}`
                        : section.label}
                    </CommandItem>
                  )),
                )}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
