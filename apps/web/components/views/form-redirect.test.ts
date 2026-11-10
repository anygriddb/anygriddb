import { afterEach, describe, expect, it, vi } from "vitest";
import { formRedirectAfterSubmit } from "./form-redirect";

describe("formRedirectAfterSubmit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("assigns a https redirect URL", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    expect(formRedirectAfterSubmit("https://example.com/thanks")).toBe(true);
    expect(assign).toHaveBeenCalledWith("https://example.com/thanks");
  });

  it("rejects missing or non-https URLs", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    expect(formRedirectAfterSubmit(undefined)).toBe(false);
    expect(formRedirectAfterSubmit("http://insecure.example")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});
