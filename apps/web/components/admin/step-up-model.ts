/**
 * What the Administration step-up dialog asks of the acting administrator
 * (ROADMAP #28): the password when they have one, otherwise the
 * authenticator code, otherwise a fresh sign-in for a passkey-only
 * provider account.
 */
export type StepUpNeed = "password" | "code" | "sign_in";

export function stepUpFields(needs: StepUpNeed): {
  password: boolean;
  code: boolean;
  signIn: boolean;
} {
  return {
    password: needs === "password",
    code: needs === "code",
    signIn: needs === "sign_in",
  };
}
