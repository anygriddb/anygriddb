import { cn } from "@anygriddb/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Check,
  ChevronRight,
  Database,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useSession } from "../../lib/session";
import { SecondFactorSetup } from "../settings/second-factor";
import { firstRunStep } from "./first-run";
import { NewBaseDialog } from "./new-base-dialog";
import { useLingui } from "@lingui/react/macro";

/** One way to start, on its own ruled line. */
function Option(props: {
  icon: LucideIcon;
  title: string;
  text: string;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex w-full items-start gap-4 border-b border-rule py-5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
    >
      <span
        aria-hidden
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground"
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-base font-semibold">{props.title}</span>
        <span className="text-sm text-muted-foreground">{props.text}</span>
      </span>
      <ChevronRight
        className="mt-1 h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
    </button>
  );
}

/**
 * The first page of a new account: protect it, then bring data. The first
 * table opens from the base, as it does every other day.
 */
export function WelcomePage() {
  const { t } = useLingui();
  const session = useSession();
  const navigate = useNavigate();
  const [skipped, setSkipped] = useState(false);
  const [creating, setCreating] = useState(false);
  // Whether the account was protected when the page opened, or since,
  // once its backup codes were acknowledged: enrolling refreshes the
  // session before the codes are read, so the step waits for that.
  const [secured, setSecured] = useState<boolean | null>(null);
  const user = session.data;
  if (user && secured === null) setSecured(user.mfaEnrolled);
  if (!user) return null;
  // A factor the policy asks for cannot be skipped (ADR 0043, ADR 0044).
  const factorNeeded = user.mfaRequired || user.mfaForBases;
  const step = firstRunStep({
    secured: secured === true,
    skipped,
    factorNeeded,
  });
  const steps = [t`Protect your account`, t`Bring your data`];
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 py-12">
        <ol
          className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm"
          aria-label={t`Steps`}
        >
          {steps.map((label, index) => {
            const number = index + 1;
            const done = number < step;
            const current = number === step;
            return (
              <li
                key={label}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2.5",
                  current
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold",
                    done && "border-primary bg-primary text-primary-foreground",
                    current && "border-primary text-primary",
                    !done && !current && "border-strong-border",
                  )}
                >
                  {done ? (
                    <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                  ) : (
                    number
                  )}
                </span>
                {label}
              </li>
            );
          })}
        </ol>

        {step === 1 ? (
          <section className="mt-10" aria-labelledby="welcome-secure">
            <h1
              id="welcome-secure"
              className="text-[28px] leading-tight font-semibold"
            >
              {t`Hello ${{ name: user.displayName }}. First, protect your account.`}
            </h1>
            <p className="mt-3 max-w-prose text-muted-foreground">
              {factorNeeded
                ? t`A second factor is asked at each sign-in after your password. On this instance it is required before you create a base.`
                : t`A second factor is asked at each sign-in after your password: an authenticator app, or a passkey.`}
            </p>
            <div className="mt-6">
              <SecondFactorSetup onDone={() => setSecured(true)} />
            </div>
            {factorNeeded ? null : (
              <p className="mt-8 text-sm text-muted-foreground">
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => setSkipped(true)}
                >
                  {t`Skip for now`}
                </button>{" "}
                {t`You can enable it later from your account settings.`}
              </p>
            )}
          </section>
        ) : (
          <section className="mt-10" aria-labelledby="welcome-data">
            <h1
              id="welcome-data"
              className="text-[28px] leading-tight font-semibold"
            >
              {t`Where do you want to start?`}
            </h1>
            <p className="mt-3 max-w-prose text-muted-foreground">
              {t`AnyGridDB works on real SQL tables: the ones it keeps for you in PostgreSQL, and the ones of a database an administrator connected.`}
            </p>
            <div className="mt-8 border-t border-rule">
              {!user.canCreateBases ? (
                <p className="border-b border-rule py-5 text-sm">
                  {t`On this instance, administrators create the bases: ask one for a base, or to be invited to one.`}
                </p>
              ) : (
                <Option
                  icon={Plus}
                  title={t`New base`}
                  text={t`A base, a first table, three fields. Kept in PostgreSQL from the first row.`}
                  onClick={() => setCreating(true)}
                />
              )}
              {user.isAdmin ? (
                <Option
                  icon={Database}
                  title={t`Connect a database`}
                  text={t`PostgreSQL, MySQL, MariaDB, or SQL Server, over TLS. Its tables become tables here; the rights stay in the database.`}
                  onClick={() => void navigate({ to: "/admin" })}
                />
              ) : null}
            </div>
            <p className="mt-8 text-sm">
              <Link to="/" className="text-primary hover:underline">
                {t`Go to the home page`}
              </Link>
            </p>
          </section>
        )}
      </div>
      <NewBaseDialog
        open={creating}
        onOpenChange={setCreating}
        mfaEnrolled={user.mfaEnrolled || !user.mfaForBases}
      />
    </div>
  );
}
