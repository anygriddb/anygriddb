import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  Input,
  Label,
  Select,
} from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { trpc, useTRPC } from "../../lib/trpc";
import type { ViewItem } from "../../lib/types";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

/** The addresses typed, apart by spaces, commas, or lines. */
export function parseEmbedSites(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/** What a site pastes to show the link in a frame. */
export function embedCode(link: string, title: string): string {
  const escaped = title.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<iframe src="${link}" title="${escaped}" loading="lazy" style="width: 100%; height: 600px; border: 0"></iframe>`;
}

export function ShareDialog({
  view,
  onClose,
}: {
  view: ViewItem;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const copy = useCopy();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const shares = useQuery(api.catalog.shares.queryOptions({ viewId: view.id }));
  // The instance's rule for public links (ADR 0043).
  const instance = useQuery(api.auth.instance.queryOptions());
  const links = instance.data?.publicLinks ?? "allowed";
  const [password, setPassword] = useState("");
  const [days, setDays] = useState("");
  const [allowCopy, setAllowCopy] = useState(false);
  const [sites, setSites] = useState("");
  const [link, setLink] = useState("");
  const [embedded, setEmbedded] = useState(false);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.catalog.shares.queryKey({ viewId: view.id }),
    });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t`Share “${{ name: view.name }}”`}
        description={
          view.viewType === "form"
            ? t`Anyone with the link can submit a response, recorded under your name.`
            : t`Anyone with the link sees this view read-only, with your rights.`
        }
      >
        {links === "off" ? (
          <p
            role="status"
            className="rounded-md border border-warning/40 bg-warning-surface p-2 text-sm"
          >
            {t`An administrator turned public links off on this instance. Links made before no longer open.`}
          </p>
        ) : null}
        <form
          hidden={links === "off"}
          className="flex flex-col gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              const created = await trpc.catalog.createShare.mutate({
                viewId: view.id,
                password: password || undefined,
                expiresInDays: days ? Number(days) : undefined,
                allowCopy,
                embedOrigins: parseEmbedSites(sites),
              });
              setLink(`${window.location.origin}/s/${created.token}`);
              setEmbedded(parseEmbedSites(sites).length > 0);
              setPassword("");
              setSites("");
              await refresh();
            } catch (cause) {
              toast.error(errorText(cause));
            }
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="share-password">
                {links === "password" ? t`Password` : t`Password (optional)`}
              </Label>
              <Input
                id="share-password"
                type="password"
                minLength={8}
                required={links === "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="share-days">{t`Expiry`}</Label>
              <Select
                id="share-days"
                value={days}
                onChange={(event) => setDays(event.target.value)}
              >
                <option value="">{t`Never`}</option>
                <option value="1">{t`1 day`}</option>
                <option value="7">{t`7 days`}</option>
                <option value="30">{t`30 days`}</option>
                <option value="90">{t`90 days`}</option>
              </Select>
            </div>
          </div>
          {view.viewType !== "form" ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={allowCopy}
                onChange={(event) => setAllowCopy(event.target.checked)}
              />
              {t`Allow copying the data`}
            </label>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="share-sites">
              {t`Sites that may embed it (optional)`}
            </Label>
            <Input
              id="share-sites"
              value={sites}
              placeholder="https://portal.example.com"
              aria-describedby="share-sites-hint"
              onChange={(event) => setSites(event.target.value)}
            />
            <p id="share-sites-hint" className="text-xs text-muted-foreground">
              {t`The addresses of the sites that may show this link in a frame, each starting with https://. Without one, no site can.`}
            </p>
          </div>
          <Button type="submit" className="self-start">
            <Link2 className="h-4 w-4" aria-hidden />
            {t`Create a link`}
          </Button>
        </form>
        {link ? (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-primary/40 bg-accent/40 p-2">
            <code className="min-w-0 flex-1 truncate text-xs">{link}</code>
            <Button
              size="xs"
              variant="outline"
              onClick={() => copy(link, t`Link copied`)}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {t`Copy`}
            </Button>
          </div>
        ) : null}
        {link && embedded ? (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border p-2">
            <code className="min-w-0 flex-1 truncate text-xs">
              {embedCode(link, view.name)}
            </code>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                copy(embedCode(link, view.name), t`Embed code copied`)
              }
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {t`Copy the embed code`}
            </Button>
          </div>
        ) : null}
        <p className="mt-4 text-xs text-muted-foreground">
          {t`The link is shown only once. Existing links:`}
        </p>
        <ul className="mt-1 divide-y divide-border text-sm">
          {(shares.data?.shares ?? []).map((share) => (
            <li key={share.id} className="flex items-center gap-2 py-1.5">
              {share.protected ? (
                <Lock
                  className="h-3.5 w-3.5 opacity-60"
                  aria-label={t`Password protected`}
                />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {t`Created by ${{ name: share.createdBy }} on ${{ date: share.createdAt.slice(0, 10) }}`}
                  {share.expiresAt
                    ? ` · ${t`expires on ${{ date: share.expiresAt.slice(0, 10) }}`}`
                    : ""}
                </span>
                {share.embedOrigins.length > 0 ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {t`Embedded in ${{ sites: share.embedOrigins.join(", ") }}`}
                  </span>
                ) : null}
              </span>
              {share.revoked ? (
                <span className="text-xs text-muted-foreground">
                  {t`revoked`}
                </span>
              ) : (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={async () => {
                    await trpc.catalog.revokeShare.mutate({
                      shareId: share.id,
                    });
                    await refresh();
                  }}
                >
                  {t`Revoke`}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
