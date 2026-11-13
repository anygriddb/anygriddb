import { describe, expect, it } from "vitest";
import { mapTiles, mapViewport, mercator, pinPlace } from "./map-tiles";

const template = "https://tiles.example.org/{z}/{x}/{y}.png";
const paris = { longitude: 2.35, latitude: 48.85 };
const tokyo = { longitude: 139.69, latitude: 35.68 };

describe("a place in Web Mercator", () => {
  it("puts the equator and the prime meridian in the middle", () => {
    expect(mercator({ longitude: 0, latitude: 0 })).toEqual({ x: 0.5, y: 0.5 });
    expect(mercator({ longitude: -180, latitude: 0 }).x).toBe(0);
    expect(mercator({ longitude: 180, latitude: 0 }).x).toBe(1);
  });

  it("stops at the last tile toward the poles", () => {
    expect(mercator({ longitude: 0, latitude: 90 }).y).toBeCloseTo(0, 9);
    expect(mercator({ longitude: 0, latitude: -90 }).y).toBeCloseTo(1, 9);
    expect(mercator({ longitude: 0, latitude: 60 }).y).toBeCloseTo(0.2904, 4);
  });
});

describe("the view of a map and its tiles", () => {
  it("shows a lone point with its town, in the middle, shaped as the map", () => {
    const viewport = mapViewport([paris], 1.5);
    expect(viewport.zoom).toBe(13);
    const spanX = viewport.maxX - viewport.minX;
    const spanY = viewport.maxY - viewport.minY;
    expect(spanX / spanY).toBeCloseTo(1.5, 9);
    const pin = pinPlace(paris, viewport);
    expect(pin.left).toBeCloseTo(50, 6);
    expect(pin.top).toBeCloseTo(50, 6);
    const tiles = mapTiles(template, viewport);
    // Paris at zoom 13, as every tile server numbers it.
    expect(tiles.map((tile) => tile.url)).toContain(
      "https://tiles.example.org/13/4149/2818.png",
    );
    expect(tiles.length).toBeGreaterThanOrEqual(12);
    expect(tiles.length).toBeLessThanOrEqual(64);
    // Tiles are square on the map: as wide in pixels as they are high.
    const [tile] = tiles;
    expect((tile?.width ?? 0) * 1.5).toBeCloseTo(tile?.height ?? 0, 6);
  });

  it("holds every point with a margin, and covers the view with tiles", () => {
    const viewport = mapViewport([paris, tokyo], 2);
    for (const point of [paris, tokyo]) {
      const pin = pinPlace(point, viewport);
      expect(pin.left).toBeGreaterThan(5);
      expect(pin.left).toBeLessThan(95);
      expect(pin.top).toBeGreaterThan(0);
      expect(pin.top).toBeLessThan(100);
    }
    const tiles = mapTiles(template, viewport);
    expect(Math.min(...tiles.map((tile) => tile.left))).toBeLessThanOrEqual(0);
    expect(
      Math.max(...tiles.map((tile) => tile.left + tile.width)),
    ).toBeGreaterThanOrEqual(100);
    expect(Math.min(...tiles.map((tile) => tile.top))).toBeLessThanOrEqual(0);
    expect(
      Math.max(...tiles.map((tile) => tile.top + tile.height)),
    ).toBeGreaterThanOrEqual(100);
  });

  it("shows the world without a point, never stretched and never past its edge", () => {
    for (const aspect of [0.5, 1, 1.5, 3, Number.NaN]) {
      const viewport = mapViewport([], aspect);
      const shape = Number.isFinite(aspect) ? aspect : 1.5;
      const spanX = viewport.maxX - viewport.minX;
      const spanY = viewport.maxY - viewport.minY;
      expect(spanX / spanY).toBeCloseTo(shape, 9);
      expect(viewport.minX).toBeGreaterThanOrEqual(0);
      expect(viewport.maxX).toBeLessThanOrEqual(1);
      expect(viewport.minY).toBeGreaterThanOrEqual(0);
      expect(viewport.maxY).toBeLessThanOrEqual(1);
      expect(mapTiles(template, viewport).length).toBeLessThanOrEqual(64);
    }
  });

  it("asks for no tile past the last of a zoom, at the world's corner", () => {
    const corner = { longitude: 179.99, latitude: -85 };
    const tiles = mapTiles(template, mapViewport([corner], 1.5));
    const last = 2 ** 13 - 1;
    for (const tile of tiles) {
      const [, x, y] = tile.key.split("/").map(Number);
      expect(x).toBeLessThanOrEqual(last);
      expect(y).toBeLessThanOrEqual(last);
    }
  });
});
