import { describe, expect, it } from "vitest";
import { writesCommandKey } from "./key-names";

describe("writesCommandKey", () => {
  it.each(["MacIntel", "macOS", "iPhone", "iPad"])(
    "writes ⌘ on %s",
    (platform) => {
      expect(writesCommandKey(platform)).toBe(true);
    },
  );

  it.each(["Win32", "Windows", "Linux x86_64", "Android", "Chrome OS", ""])(
    "writes Ctrl on %s",
    (platform) => {
      expect(writesCommandKey(platform)).toBe(false);
    },
  );
});
