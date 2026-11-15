import { useLingui } from "@lingui/react/macro";

/**
 * The words for what the change trail records. Shared by the trail and an
 * account's page, which lists the same events for one author.
 */
export function useChangeActionLabel(): (action: string) => string {
  const { t } = useLingui();
  const actions: Record<string, string> = {
    insert: t`Creation`,
    update: t`Edit`,
    delete: t`Delete`,
    submit: t`Submission`,
    lock: t`Lock`,
    unlock: t`Unlock`,
    sign: t`Signature`,
    catalog: t`Structure`,
    export: t`Export`,
    open: t`Opened`,
    purge: t`Purge`,
    access: t`Base opened`,
  };
  return (action) => actions[action] ?? action;
}
