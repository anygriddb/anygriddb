/**
 * A basemap under the map view's pins (ADR 0068): tiles from the server
 * the operator names, drawn as plain images in Web Mercator. No map
 * library: the tiles a view needs, and where each goes, are worked out
 * here.
 */
import { fillMapTileUrl } from "@anygriddb/core";

/** Past this latitude Web Mercator has no tile. */
const MAX_LATITUDE = 85.051_128_78;
/** Tiles across the wider side: each is drawn near its own size. */
const TILES_ACROSS = 6;
const MAX_ZOOM = 18;
/** The narrowest view: a lone point shows its town, not its doorstep. */
const MIN_SPAN = TILES_ACROSS / 2 ** 14;
/** The most tile images one map asks for. */
const MAX_TILES = 64;

export type MapPoint = { longitude: number; latitude: number };

/** The part of the world a map shows, in Web Mercator's 0 to 1, and its zoom. */
export type MapViewport = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  zoom: number;
};

export type MapTile = {
  key: string;
  url: string;
  /** Its place and size, in percent of the map. */
  left: number;
  top: number;
  width: number;
  height: number;
};

/** A place in Web Mercator: 0 to 1 from west to east and from north to south. */
export function mercator(point: MapPoint): { x: number; y: number } {
  const latitude = Math.max(
    -MAX_LATITUDE,
    Math.min(MAX_LATITUDE, point.latitude),
  );
  const radians = (latitude * Math.PI) / 180;
  return {
    x: (point.longitude + 180) / 360,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2,
  };
}

/** A range of `span` around the middle of [min, max], kept inside 0 to 1. */
function around(min: number, max: number, span: number): [number, number] {
  const start = Math.max(0, Math.min(1 - span, (min + max) / 2 - span / 2));
  return [start, start + span];
}

function tileRange(min: number, max: number, zoom: number): [number, number] {
  const count = 2 ** zoom;
  return [
    Math.floor(min * count),
    Math.min(count - 1, Math.floor(max * count - 1e-9)),
  ];
}

/**
 * The view that holds every point with a margin, shaped as the map is
 * (`aspect`, its width over its height), or the world when there is no
 * point. A view larger than the world shrinks to it, keeping its shape:
 * the map is never stretched.
 */
export function mapViewport(
  points: readonly MapPoint[],
  aspect: number,
): MapViewport {
  const shape = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.5;
  const places = points.map(mercator);
  const xs = places.map((place) => place.x);
  const ys = places.map((place) => place.y);
  const [minX, maxX] =
    places.length > 0 ? [Math.min(...xs), Math.max(...xs)] : [0, 1];
  const [minY, maxY] =
    places.length > 0 ? [Math.min(...ys), Math.max(...ys)] : [0, 1];
  let spanX = Math.max((maxX - minX) * 1.3, MIN_SPAN);
  let spanY = Math.max((maxY - minY) * 1.3, MIN_SPAN);
  if (spanX / spanY < shape) spanX = spanY * shape;
  else spanY = spanX / shape;
  // The world is one unit wide and high: a view larger than it shrinks,
  // keeping its shape.
  const over = Math.max(spanX, spanY, 1);
  spanX /= over;
  spanY /= over;
  const [left, right] = around(minX, maxX, spanX);
  const [top, bottom] = around(minY, maxY, spanY);
  let zoom = Math.max(
    0,
    Math.min(
      MAX_ZOOM,
      Math.floor(Math.log2(TILES_ACROSS / Math.max(spanX, spanY))),
    ),
  );
  const count = (level: number) => {
    const [x0, x1] = tileRange(left, right, level);
    const [y0, y1] = tileRange(top, bottom, level);
    return (x1 - x0 + 1) * (y1 - y0 + 1);
  };
  while (zoom > 0 && count(zoom) > MAX_TILES) zoom -= 1;
  return { minX: left, maxX: right, minY: top, maxY: bottom, zoom };
}

/** The tiles that cover the view, each with its address and its place. */
export function mapTiles(template: string, viewport: MapViewport): MapTile[] {
  const count = 2 ** viewport.zoom;
  const spanX = viewport.maxX - viewport.minX;
  const spanY = viewport.maxY - viewport.minY;
  const [x0, x1] = tileRange(viewport.minX, viewport.maxX, viewport.zoom);
  const [y0, y1] = tileRange(viewport.minY, viewport.maxY, viewport.zoom);
  const tiles: MapTile[] = [];
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      tiles.push({
        key: `${String(viewport.zoom)}/${String(x)}/${String(y)}`,
        url: fillMapTileUrl(template, viewport.zoom, x, y),
        left: ((x / count - viewport.minX) / spanX) * 100,
        top: ((y / count - viewport.minY) / spanY) * 100,
        width: (1 / count / spanX) * 100,
        height: (1 / count / spanY) * 100,
      });
    }
  }
  return tiles;
}

/** Where a point's pin goes, in percent of the map. */
export function pinPlace(
  point: MapPoint,
  viewport: MapViewport,
): { left: number; top: number } {
  const { x, y } = mercator(point);
  return {
    left: ((x - viewport.minX) / (viewport.maxX - viewport.minX)) * 100,
    top: ((y - viewport.minY) / (viewport.maxY - viewport.minY)) * 100,
  };
}
