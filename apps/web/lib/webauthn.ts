import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { trpc } from "./trpc";

function requestOptions(options: {
  challenge: string;
  timeout?: number;
  rpId?: string;
  userVerification?: PublicKeyCredentialRequestOptionsJSON["userVerification"];
  allowCredentials?: PublicKeyCredentialRequestOptionsJSON["allowCredentials"];
}): PublicKeyCredentialRequestOptionsJSON {
  return {
    challenge: options.challenge,
    timeout: options.timeout,
    rpId: options.rpId,
    userVerification: options.userVerification,
    allowCredentials: options.allowCredentials,
  };
}

function attachmentOf(
  value: string | undefined,
): "platform" | "cross-platform" | undefined {
  return value === "platform" || value === "cross-platform" ? value : undefined;
}

function registrationPayload(response: RegistrationResponseJSON) {
  return {
    id: response.id,
    rawId: response.rawId,
    type: "public-key" as const,
    authenticatorAttachment: attachmentOf(response.authenticatorAttachment),
    clientExtensionResults: {},
    response: {
      clientDataJSON: response.response.clientDataJSON,
      attestationObject: response.response.attestationObject,
      transports: response.response.transports,
    },
  };
}

function authenticationPayload(response: AuthenticationResponseJSON) {
  return {
    id: response.id,
    rawId: response.rawId,
    type: "public-key" as const,
    authenticatorAttachment: attachmentOf(response.authenticatorAttachment),
    clientExtensionResults: {},
    response: {
      clientDataJSON: response.response.clientDataJSON,
      authenticatorData: response.response.authenticatorData,
      signature: response.response.signature,
      userHandle: response.response.userHandle,
    },
  };
}

/** Second factor with a passkey, after the password step. */
export async function signInWithPasskey(): Promise<void> {
  const options = await trpc.auth.webauthn.authenticateBegin.mutate();
  const response = await startAuthentication({
    optionsJSON: requestOptions(options),
  });
  await trpc.auth.webauthn.authenticateFinish.mutate(
    authenticationPayload(response),
  );
}

/** Registers a passkey. Returns fresh backup codes when the account had none. */
export async function registerPasskey(): Promise<string[]> {
  const options = await trpc.auth.webauthn.registerBegin.mutate();
  const response = await startRegistration({
    optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
  });
  const result = await trpc.auth.webauthn.registerFinish.mutate(
    registrationPayload(response),
  );
  return result.backupCodes;
}
