export {
  assertOutboundTarget,
  isOutboundBlocked,
  type OutboundResolve,
} from "./target.js";
export {
  outboundLookup,
  postOutbound,
  requestOutbound,
  type OutboundAnswer,
} from "./request.js";
export { outboundFetch } from "./fetch.js";
export { sendTlsFrame, type TlsCollector } from "./tls-frame.js";
export { outboundFailureText, redactSecrets, secretStrings } from "./redact.js";
