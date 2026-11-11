import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSection,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@anygriddb/ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
  Keyboard,
  ShieldCheck,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useLocale } from "../../lib/i18n";
import { useTheme, type ThemeChoice } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { openShortcuts } from "./shortcuts-dialog";
import { useLingui } from "@lingui/react/macro";

export function UserMenu({
  user,
}: {
  user: {
    displayName: string;
    email: string;
    isAdmin?: boolean;
    isSupport?: boolean;
  };
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();
  const themes: Array<[ThemeChoice, string, typeof Sun]> = [
    ["light", t`Light`, Sun],
    ["dark", t`Dark`, Moon],
    ["system", t`System`, Monitor],
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted">
        <Avatar name={user.displayName} />
        <span className="truncate text-sm font-medium">{user.displayName}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuSection title={user.email}>
          <DropdownMenuItem onSelect={() => void navigate({ to: "/settings" })}>
            <Settings className="h-4 w-4" aria-hidden />
            {t`Account settings`}
          </DropdownMenuItem>
          {user.isAdmin || user.isSupport ? (
            <DropdownMenuItem onSelect={() => void navigate({ to: "/admin" })}>
              <ShieldCheck className="h-4 w-4" aria-hidden />
              {t`Administration`}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={openShortcuts}>
            <Keyboard className="h-4 w-4" aria-hidden />
            {t`Keyboard shortcuts`}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Sun className="h-4 w-4" aria-hidden />
              {t`Theme`}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {themes.map(([value, label, Icon]) => (
                <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
                  <Icon className="h-4 w-4" aria-hidden />
                  {label}
                  {theme === value ? (
                    <Check className="ml-auto h-4 w-4" aria-hidden />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Languages className="h-4 w-4" aria-hidden />
              {t`Language`}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {(["fr", "en"] as const).map((value) => (
                <DropdownMenuItem key={value} onSelect={() => setLocale(value)}>
                  {value === "fr" ? "Français" : "English"}
                  {locale === value ? (
                    <Check className="ml-auto h-4 w-4" aria-hidden />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuSection>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await trpc.auth.logout.mutate();
            queryClient.clear();
            void navigate({ to: "/login", replace: true });
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          {t`Sign out`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
