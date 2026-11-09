/**
 * Which step of the first-run page to show: protecting the account (1), or
 * bringing data (2). A factor the policy asks for cannot be skipped.
 */
export function firstRunStep(state: {
  /** The account has a second factor, acknowledged backup codes included. */
  secured: boolean;
  /** The person chose to go on without one. */
  skipped: boolean;
  /** The instance asks for a factor, for this account or to create bases. */
  factorNeeded: boolean;
}): 1 | 2 {
  if (state.secured) return 2;
  if (state.skipped && !state.factorNeeded) return 2;
  return 1;
}
