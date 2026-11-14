/** Types for raster.mjs (plain JavaScript, run by Node without a build). */
export interface Layer {
  mask: (x: number, y: number) => boolean;
  color?: (x: number, y: number) => string;
  alpha?: (x: number, y: number) => number;
  erase?: boolean;
}
/** Premultiplied floats: color 0..255, alpha 0..1. */
export interface Image {
  N: number;
  px: Float32Array;
}
export function rgb(hex: string): [number, number, number];
export function render(N: number, layers: Layer[], view?: { k?: number; ox?: number; oy?: number }): Image;
export function resize(img: Image, M: number): Image;
export function gray(img: Image): Image;
export function png(img: Image, options?: { opaque?: boolean }): Buffer;
export function ico(images: { size: number; png: Buffer }[]): Buffer;
