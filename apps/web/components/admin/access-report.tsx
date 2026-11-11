import { Button } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { datedName, downloadCsv } from "../../lib/download";
import { useErrorText } from "../../lib/errors";
import { trpc } from "../../lib/trpc";
import { RuledSection } from "../shell/notebook-page";

/**
 * Who has access (ROADMAP #49: beside the security policy): every account,
 * its bases and roles, and its last sign-in, as a CSV file.
 */
export function AccessReport() {
  const { t } = useLingui();
  const errorText = useErrorText();
  return (
    <RuledSection
      title={t`Who has access`}
      description={t`Every account, its bases and roles, and its last sign-in, as a CSV file.`}
    >
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          void (async () => {
            try {
              const report = await trpc.admin.accessReport.mutate();
              downloadCsv(datedName("anygriddb-access", "csv"), report.csv);
            } catch (cause) {
              toast.error(errorText(cause));
            }
          })()
        }
      >
        <Download className="h-4 w-4" aria-hidden />
        {t`Export who has access`}
      </Button>
    </RuledSection>
  );
}
