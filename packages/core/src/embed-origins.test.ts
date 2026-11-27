import { describe, expect, it } from "vitest";
import { AppError } from "./errors.js";
import {
  isEmbedOrigin,
  normalizeEmbedOrigin,
  normalizeEmbedOrigins,
  storedEmbedOrigins,
} from "./embed-origins.js";

describe("embed origins", () => {
  it("accepts an HTTPS origin and refuses wildcards, remote HTTP, and paths", () => {
    expect(isEmbedOrigin("https://portal.example.com")).toBe(true);
    expect(isEmbedOrigin("https://portal.example.com:8443")).toBe(true);
    expect(isEmbedOrigin("https://portal.example.com/")).toBe(true);
    expect(isEmbedOrigin("*")).toBe(false);
    expect(isEmbedOrigin("https://*")).toBe(false);
    expect(isEmbedOrigin("http://portal.example.com")).toBe(false);
    expect(isEmbedOrigin("https://portal.example.com/path")).toBe(false);
    expect(isEmbedOrigin("https://user:pass@portal.example.com")).toBe(false);
    expect(isEmbedOrigin("https://portal.example.com?x=1")).toBe(false);
  });

  it("accepts HTTP only on this machine", () => {
    expect(isEmbedOrigin("http://127.0.0.1")).toBe(true);
    expect(isEmbedOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isEmbedOrigin("http://localhost")).toBe(true);
    expect(isEmbedOrigin("http://localhost:5173")).toBe(true);
    expect(isEmbedOrigin("http://[::1]")).toBe(true);
    expect(normalizeEmbedOrigin("http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("normalises a list, drops empties, and refuses bad entries", () => {
    expect(normalizeEmbedOrigins(null)).toBeNull();
    expect(normalizeEmbedOrigins([])).toBeNull();
    expect(
      normalizeEmbedOrigins([
        "https://a.example.com/",
        "https://a.example.com",
        "https://b.example.com",
      ]),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(() => normalizeEmbedOrigins(["*"])).toThrow(AppError);
    expect(() => normalizeEmbedOrigins(["http://a.example.com"])).toThrow(
      AppError,
    );
    expect(normalizeEmbedOrigin("https://grid.example.org/")).toBe(
      "https://grid.example.org",
    );
  });

  it("reads a stored jsonb array and ignores a corrupt value", () => {
    expect(storedEmbedOrigins(["https://a.example.com"])).toEqual([
      "https://a.example.com",
    ]);
    expect(storedEmbedOrigins("https://a.example.com")).toBeNull();
    expect(storedEmbedOrigins([1, "https://a.example.com"])).toEqual([
      "https://a.example.com",
    ]);
    expect(storedEmbedOrigins(["*"])).toBeNull();
  });
});
