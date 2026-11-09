import { AppError } from "@anygriddb/core";
export function relyingParty(origin: string): { rpID: string; origin: string } {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new AppError("invalid_origin");
  }
  const localhost = url.hostname === "localhost";
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(localhost && url.protocol === "http:"))
  ) {
    throw new AppError("invalid_origin");
  }
  return { rpID: url.hostname, origin: url.origin };
}
