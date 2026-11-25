import type { Permission } from "@anygriddb/core";
import { useLingui } from "@lingui/react/macro";

/**
 * The permissions of a base (ADR 0127), by family, as a role made in
 * Administration shows and chooses them (ADR 0128).
 */
export function usePermissionFamilies(): ReadonlyArray<{
  label: string;
  permissions: ReadonlyArray<{
    permission: Permission;
    label: string;
    hint: string;
  }>;
}> {
  const { t } = useLingui();
  return [
    {
      label: t`Rows`,
      permissions: [
        {
          permission: "rows.read",
          label: t`Read rows`,
          hint: t`Rows, their history and comments, and views of one's own. Every role reads.`,
        },
        {
          permission: "rows.comment",
          label: t`Comment`,
          hint: t`Comment on rows and answer comments.`,
        },
        {
          permission: "rows.write",
          label: t`Edit rows`,
          hint: t`Add and change rows, submit a draft, press a button.`,
        },
        {
          permission: "rows.delete",
          label: t`Delete rows`,
          hint: t`Move rows to the trash and bring them back.`,
        },
        {
          permission: "rows.lock",
          label: t`Lock and sign rows`,
          hint: t`Lock, sign and unlock rows, and take the steps a status circuit gives owners.`,
        },
        {
          permission: "rows.transition",
          label: t`Take a circuit's steps`,
          hint: t`Take the steps of a table's circuit that name this role, or the role of owners or editors it stands for. Validating needs no right to edit or lock.`,
        },
      ],
    },
    {
      label: t`Data`,
      permissions: [
        {
          permission: "data.export",
          label: t`Export`,
          hint: t`Rows taken out: files, calendar feeds, a base's backup and copies, links that show rows, webhooks, and automations that send values elsewhere.`,
        },
        {
          permission: "api.access",
          label: t`Reach by a token`,
          hint: t`The API, MCP and the applications given access act here with this role. Without it, a token reaches nothing here.`,
        },
        {
          permission: "data.import",
          label: t`Import`,
          hint: t`Files into a table, and a workbook as new tables.`,
        },
        {
          permission: "publish",
          label: t`Publish`,
          hint: t`Public links to a view, a form or a whole base.`,
        },
      ],
    },
    {
      label: t`Structure`,
      permissions: [
        {
          permission: "views.manage",
          label: t`Shared views`,
          hint: t`Views everyone with a role sees, and their order.`,
        },
        {
          permission: "dashboards.manage",
          label: t`Dashboards`,
          hint: t`Make and change dashboards and their widgets.`,
        },
        {
          permission: "schema.manage",
          label: t`Tables and fields`,
          hint: t`Tables, folders, fields, status circuits and locked views.`,
        },
      ],
    },
    {
      label: t`Automation`,
      permissions: [
        {
          permission: "automations.manage",
          label: t`Automations`,
          hint: t`Make, change and run a table's automations.`,
        },
        {
          permission: "webhooks.manage",
          label: t`Webhooks`,
          hint: t`Send a table's changes to an address outside the instance.`,
        },
      ],
    },
    {
      label: t`The base`,
      permissions: [
        {
          permission: "members.manage",
          label: t`Members`,
          hint: t`Give roles no wider than this one, invite, and set each member's field and row rules.`,
        },
        {
          permission: "base.manage",
          label: t`The base itself`,
          hint: t`Its name, its trash, its copies, restore points and backups.`,
        },
      ],
    },
  ];
}
