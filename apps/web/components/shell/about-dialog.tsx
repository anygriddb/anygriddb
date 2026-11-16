import { Dialog, DialogContent } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Where the source of this software is published. Whoever runs a changed
 * version names here where its own source is: the license asks that its
 * users be offered it (AGPL-3.0, section 13).
 */
const SOURCE_URL = "https://github.com/anygriddb/anygriddb";

/** Opens the notice from anywhere, e.g. a menu item. */
export function openAbout(): void {
  window.dispatchEvent(new Event("ag:about"));
}

/**
 * What the license asks an interface to show: whose work this is, that it
 * comes without warranty, that it may be shared under its license, and
 * where that license, the source, and the libraries' own licenses are.
 * The two text files are written by the build
 * (`scripts/third-party-licenses.mjs`).
 */
export function AboutDialog() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("ag:about", onOpen);
    return () => window.removeEventListener("ag:about", onOpen);
  }, []);
  const links: Array<[string, string]> = [
    [SOURCE_URL, t`Source code`],
    ["/license.txt", t`The license`],
    ["/third-party-licenses.txt", t`Licenses of the libraries it uses`],
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={t`About AnyGridDB`}>
        <div className="flex flex-col gap-3 text-sm">
          <p>
            {t`AnyGridDB is free software: you may use it, study it, share it, and change it under the GNU Affero General Public License, version 3 or any later version.`}
          </p>
          <p>{t`It comes with no warranty, to the extent the law allows.`}</p>
          <p className="text-muted-foreground">
            {t`Copyright © the AnyGridDB contributors, and the authors of the libraries it is built with.`}
          </p>
          <ul className="flex flex-col gap-1.5">
            {links.map(([href, label]) => (
              <li key={href}>
                <a
                  className="inline-flex items-center gap-1 text-primary underline"
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {label}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
