import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Input,
  Label,
  ListPicker,
  Select,
  Spinner,
  type PickerOption,
} from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import type { Role } from "../../lib/types";
import { LoadFailed } from "../shell/load-failed";
import {
  ACCOUNT_ACTIONS,
  useAccountActions,
  type AccountTarget,
} from "./account-actions";
import {
  ACCOUNTS_PAGE,
  filtered,
  nextSearch,
  sortSearch,
  usersQuery,
  type AccountsSearch,
} from "./accounts-search";
import { InvitationsPanel } from "./invitations-panel";
import { useRoleLabel } from "../settings/role-label";

function date(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/** The fields an action needs, from a row of the list. */
export function accountTarget(user: {
  id: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  disabledAt: string | null;
  lock: { until: string | null } | null;
  hasPassword: boolean;
  signOn: boolean;
  provisioned: boolean;
  deprovisioned: boolean;
}): AccountTarget {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    isAdmin: user.isAdmin,
    disabled: user.disabledAt !== null,
    locked: user.lock !== null,
    hasPassword: user.hasPassword,
    signOn: user.signOn,
    managed: user.provisioned && !user.deprovisioned,
  };
}

/**
 * Accounts (ROADMAP #18, #67): add a person, find anyone by name, status,
 * administration, second factor, or origin, sort by a column, open an
 * account's page, and disable or delete from its row; every other action
 * is in the row's menu. The filters live in the address (ROADMAP #49).
 * Pending invitations follow.
 */
export function AccountsTab({
  search,
  onSearch,
}: {
  search: AccountsSearch;
  /** Changes the address from what it holds when the change lands. */
  onSearch: (update: (current: AccountsSearch) => AccountsSearch) => void;
}) {
  const { t } = useLingui();
  const api = useTRPC();
  const session = useSession();
  const isAdmin = session.data?.isAdmin === true;
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState(search.q ?? "");
  const query = usersQuery(search);
  const list = useQuery({
    ...api.admin.users.queryOptions(query),
    placeholderData: keepPreviousData,
  });
  const actions = useAccountActions({ mails: list.data?.smtpReady ?? false });
  const total = list.data?.total ?? 0;
  const offset = query.offset;
  const page = search.page ?? 1;

  // The box keeps what is typed, spaces included, and the address follows
  // a moment after the last key. A change of address the box did not make
  // (back, a shared link) refills it; the search it sent itself never
  // overwrites what is still being typed.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sent, setSent] = useState(search.q);
  const [seen, setSeen] = useState(search.q);
  if (search.q !== seen) {
    setSeen(search.q);
    if (search.q !== sent) setText(search.q ?? "");
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  const type = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const q = value.trim() || undefined;
      setSent(q);
      onSearch((current) => nextSearch(current, { q }));
    }, 250);
  };
  const filter = (patch: Partial<AccountsSearch>) =>
    onSearch((current) => nextSearch(current, patch));

  const header = (sort: NonNullable<AccountsSearch["sort"]>, label: string) => {
    const active = (search.sort ?? "created") === sort;
    const descending = (search.dir ?? "asc") === "desc";
    return (
      <th
        className="px-3 py-2"
        aria-sort={active ? (descending ? "descending" : "ascending") : "none"}
      >
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:underline"
          onClick={() => onSearch((current) => sortSearch(current, sort))}
        >
          {label}
          {active ? (
            descending ? (
              <ArrowDown className="h-3 w-3" aria-hidden />
            ) : (
              <ArrowUp className="h-3 w-3" aria-hidden />
            )
          ) : null}
        </button>
      </th>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {plural(total, { one: "# account", other: "# accounts" })}
        </p>
        {isAdmin ? (
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t`Add a person`}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="accounts-search">{t`Search accounts`}</Label>
          <Input
            id="accounts-search"
            type="search"
            placeholder={t`Name or email`}
            className="w-56"
            maxLength={100}
            value={text}
            onChange={(event) => type(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="accounts-status">{t`Status`}</Label>
          <Select
            id="accounts-status"
            value={search.status ?? ""}
            onChange={(event) =>
              filter({
                status: (event.target.value || undefined) as
                  AccountsSearch["status"] | undefined,
              })
            }
          >
            <option value="">{t`All`}</option>
            <option value="active">{t`Active`}</option>
            <option value="disabled">{t`Disabled`}</option>
            <option value="locked">{t`Locked`}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="accounts-admin">{t`Administrator`}</Label>
          <Select
            id="accounts-admin"
            value={search.admin ?? ""}
            onChange={(event) =>
              filter({
                admin: (event.target.value || undefined) as
                  AccountsSearch["admin"] | undefined,
              })
            }
          >
            <option value="">{t`All`}</option>
            <option value="yes">{t`Administrators`}</option>
            <option value="no">{t`Not administrators`}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="accounts-mfa">{t`Second factor`}</Label>
          <Select
            id="accounts-mfa"
            value={search.mfa ?? ""}
            onChange={(event) =>
              filter({
                mfa: (event.target.value || undefined) as
                  AccountsSearch["mfa"] | undefined,
              })
            }
          >
            <option value="">{t`All`}</option>
            <option value="yes">{t`With`}</option>
            <option value="no">{t`Without`}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="accounts-origin">{t`Origin`}</Label>
          <Select
            id="accounts-origin"
            value={search.origin ?? ""}
            onChange={(event) =>
              filter({
                origin: (event.target.value || undefined) as
                  AccountsSearch["origin"] | undefined,
              })
            }
          >
            <option value="">{t`All`}</option>
            <option value="local">{t`Made here`}</option>
            <option value="sso">{t`Single sign-on`}</option>
            <option value="scim">{t`Identity provider (SCIM)`}</option>
          </Select>
        </div>
      </div>
      {list.isLoading ? <Spinner /> : null}
      {list.error ? (
        <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.data && list.data.users.length === 0 ? (
        <p className="rounded-sm border border-dashed border-border p-4 text-sm text-muted-foreground">
          {filtered(search)
            ? t`No account matches these filters. Clear a filter, or add the person.`
            : t`No account yet besides yours. Add a person to bring them in.`}
        </p>
      ) : null}
      {list.data && list.data.users.length > 0 ? (
        <div className="overflow-x-auto rounded-sm border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs">
              <tr>
                {header("name", t`Account`)}
                {header("created", t`Created`)}
                {header("lastSeen", t`Last sign-in`)}
                <th className="px-3 py-2">{t`Second factor`}</th>
                <th className="px-3 py-2">{t`Bases`}</th>
                <th className="px-3 py-2">{t`Status`}</th>
                <th className="px-3 py-2">
                  <span className="sr-only">{t`Actions`}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.users.map((user) => {
                const target = accountTarget(user);
                const self = user.id === session.data?.id;
                return (
                  <tr key={user.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Avatar name={user.displayName} />
                        <div className="min-w-0">
                          <Link
                            to="/admin/people/accounts/$userId"
                            params={{ userId: user.id }}
                            className="block truncate font-medium hover:underline"
                          >
                            {user.displayName}
                          </Link>
                          <p className="truncate text-xs text-muted-foreground">
                            {user.email}
                          </p>
                        </div>
                        {user.isAdmin ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                            {t`Administrator`}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {date(user.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-xs">{date(user.lastSeen)}</td>
                    <td className="px-3 py-2 text-xs">
                      {user.mfa ? t`Yes` : t`No`}
                    </td>
                    <td className="px-3 py-2 text-xs tabular-nums">
                      {user.bases}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <StatusText user={user} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {self ? (
                          <span className="px-2 text-xs text-muted-foreground">
                            {t`You`}
                          </span>
                        ) : (
                          <>
                            {actions.button("disable", target)}
                            {actions.button("delete", target)}
                          </>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={t`Actions for ${{ name: user.displayName }}`}
                            className="rounded p-1 hover:bg-muted"
                          >
                            <MoreHorizontal className="h-4 w-4" aria-hidden />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            {ACCOUNT_ACTIONS.map((action) =>
                              actions.menuItem(action, target),
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {total > ACCOUNTS_PAGE ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {t`${{ from: offset + 1 }}–${{ to: Math.min(offset + ACCOUNTS_PAGE, total) }} of ${total}`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page <= 1}
            onClick={() => filter({ page: page - 1 })}
          >
            {t`Previous`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset + ACCOUNTS_PAGE >= total}
            onClick={() => filter({ page: page + 1 })}
          >
            {t`Next`}
          </Button>
        </div>
      ) : null}

      {isAdmin ? (
        <div id="invitations" className="scroll-mt-4">
          <InvitationsPanel />
        </div>
      ) : null}

      {adding ? (
        <AddPersonDialog
          mails={list.data?.smtpReady ?? false}
          onClose={() => setAdding(false)}
          onHanded={(name, link) => actions.hand({ name, link })}
          onAdded={() => void list.refetch()}
        />
      ) : null}
      {actions.dialogs}
    </div>
  );
}

/** Disabled, locked, kept by the identity provider: what the row says. */
export function StatusText({
  user,
}: {
  user: {
    disabledAt: string | null;
    disabledReason?: string | null;
    lock: { until: string | null } | null;
    provisioned: boolean;
    deprovisioned: boolean;
  };
}) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-0.5">
      {user.disabledAt ? (
        <span className="text-danger">
          {user.disabledReason === "inactive"
            ? t`Disabled on ${{ date: date(user.disabledAt) }}, unused`
            : t`Disabled on ${{ date: date(user.disabledAt) }}`}
        </span>
      ) : (
        <span>{t`Active`}</span>
      )}
      {user.lock ? (
        <span className="flex items-start gap-1 text-warning">
          <LockKeyhole className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {user.lock.until
            ? t`Locked until ${{ date: date(user.lock.until) }}`
            : t`Locked until unlocked`}
        </span>
      ) : null}
      {user.provisioned ? (
        <span className="text-muted-foreground">
          {user.deprovisioned
            ? t`Removed by the identity provider`
            : t`Kept by the identity provider`}
        </span>
      ) : null}
    </div>
  );
}

const ROLES: readonly Role[] = ["owner", "editor", "commenter", "viewer"];

/** A base chosen for the person, with the role they get on it. */
type Membership = {
  baseId: string;
  name: string;
  owners: string;
  role: Role;
};

/** At most this many bases at creation, as the server allows. */
const MAX_BASES = 20;

/**
 * Adding a person (ROADMAP #67): who they are, whether they administer
 * the instance, and the bases they reach from the start, found by name
 * among every live base of the instance (ADR 0057). The first link goes
 * to them by mail, or comes back to pass on.
 */
function AddPersonDialog({
  mails,
  onClose,
  onHanded,
  onAdded,
}: {
  mails: boolean;
  onClose: () => void;
  onHanded: (name: string, link: string) => void;
  onAdded: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const roleLabel = useRoleLabel();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [admin, setAdmin] = useState(false);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [picking, setPicking] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const bases = useQuery({
    ...api.admin.bases.list.queryOptions({
      search: typed.trim() || undefined,
      limit: 50,
    }),
    enabled: picking,
    placeholderData: keepPreviousData,
  });
  const found = bases.data?.bases ?? [];
  const options: PickerOption[] = found.map((base) => {
    const owners = base.owners.join(", ");
    return {
      id: base.id,
      textValue: owners
        ? t`${{ base: base.name }}, owned by ${{ owners }}`
        : base.name,
      children: (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{base.name}</span>
          {owners ? (
            <span className="truncate text-xs text-muted-foreground">
              {t`Owned by ${{ owners }}`}
            </span>
          ) : null}
        </span>
      ),
    };
  });
  const toggle = (baseId: string) => {
    if (memberships.some((row) => row.baseId === baseId)) {
      setMemberships((rows) => rows.filter((row) => row.baseId !== baseId));
      return;
    }
    const base = found.find((row) => row.id === baseId);
    if (!base || memberships.length >= MAX_BASES) return;
    setMemberships((rows) => [
      ...rows,
      {
        baseId,
        name: base.name,
        owners: base.owners.join(", "),
        role: "viewer",
      },
    ]);
  };

  async function add() {
    const displayName = name.trim();
    if (!email.trim() || !displayName || busy) return;
    setBusy(true);
    try {
      const result = await trpc.admin.createAccount.mutate({
        email: email.trim(),
        displayName,
        admin,
        memberships: memberships.map(({ baseId, role }) => ({
          baseId,
          role,
        })),
      });
      onAdded();
      onClose();
      if (result.sent) {
        toast.success(
          t`${{ name: displayName }} added. Their link went to ${{ to: result.to }}`,
        );
      } else {
        toast.success(t`${{ name: displayName }} added`);
        onHanded(displayName, result.link);
      }
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t`Add a person`}
        description={
          mails
            ? t`They get a link by email to choose their password, valid a week.`
            : t`Email is not set up: you get the link to choose their password, valid a week, to pass on to them.`
        }
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-person-name">{t`Display name`}</Label>
              <Input
                id="add-person-name"
                autoComplete="off"
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-person-email">{t`Email`}</Label>
              <Input
                id="add-person-email"
                type="email"
                autoComplete="off"
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={admin}
              onChange={(event) => setAdmin(event.target.checked)}
            />
            {t`Administrator of the instance`}
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t`Bases`}</legend>
            {memberships.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t`Optional: the bases they reach from the start, and their role on each. Any base of the instance; each role is on the change trail under your name.`}
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {memberships.map((row) => (
                  <li key={row.baseId} className="flex items-center gap-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{row.name}</span>
                      {row.owners ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {t`Owned by ${{ owners: row.owners }}`}
                        </span>
                      ) : null}
                    </span>
                    <Select
                      aria-label={t`Role on ${{ base: row.name }}`}
                      className="w-36"
                      value={row.role}
                      onChange={(event) =>
                        setMemberships((rows) =>
                          rows.map((other) =>
                            other.baseId === row.baseId
                              ? { ...other, role: event.target.value as Role }
                              : other,
                          ),
                        )
                      }
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {roleLabel(role)}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t`Remove ${{ base: row.name }}`}
                      onClick={() => toggle(row.baseId)}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {picking ? (
              <div className="flex flex-col rounded-sm border border-border">
                <ListPicker
                  label={t`Find a base`}
                  listLabel={t`Bases of the instance`}
                  inputValue={typed}
                  onInputChange={setTyped}
                  options={options}
                  selectionMode="multiple"
                  selected={memberships.map((row) => row.baseId)}
                  onToggle={toggle}
                  className="max-h-48"
                  empty={
                    bases.isLoading ? (
                      <span className="flex justify-center">
                        <Spinner />
                      </span>
                    ) : (
                      t`No base by that name`
                    )
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-end"
                  onClick={() => setPicking(false)}
                >
                  {t`Done`}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={memberships.length >= MAX_BASES}
                onClick={() => setPicking(true)}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {t`Add bases`}
              </Button>
            )}
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t`Cancel`}
          </Button>
          <Button
            disabled={busy || !email.trim() || !name.trim()}
            onClick={() => void add()}
          >
            {t`Add`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
