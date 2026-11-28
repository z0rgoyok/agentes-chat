import { catalogFont, type FontRef, nearestWeight } from "@agenteschat/live";
import * as Font from "expo-font";
import { useEffect, useState } from "react";
import type { TextStyle } from "react-native";
import { useServer } from "@/lib/server";

/**
 * Fonts of live files on the phone (ADR 0220 §8): React Native picks a face by its name, not by weight, so each
 * catalog face (a family at a weight and slant) is registered under a name of its own (`lf-inter-700`), loaded from the
 * server's static files when a file first uses it. Until it loads, and for a face the server doesn't have, the text
 * shows in the system's font at the weight it asks.
 */

export interface NativeFace {
  ref: FontRef | undefined;
  weight: number;
  italic: boolean;
}

const statics = new Map<string, Promise<Record<string, string> | null>>();
const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

const weightStyle = (w: number): TextStyle["fontWeight"] =>
  String(Math.min(900, Math.max(100, Math.round(w / 100) * 100))) as TextStyle["fontWeight"];

/** The registered name of a catalog face, or null for a ref the phone doesn't load (a file's own font). */
function faceName(face: NativeFace): { id: string; key: string; name: string } | null {
  const font = face.ref ? catalogFont(face.ref) : undefined;
  if (!font) return null;
  const weight = nearestWeight(font, face.weight);
  const key = `${weight}${face.italic && font.italic ? "i" : ""}`;
  return { id: font.id, key, name: `lf-${font.id}-${key}` };
}

async function staticFiles(server: string, id: string): Promise<Record<string, string> | null> {
  let hit = statics.get(id);
  if (!hit) {
    hit = fetch(`${server}/api/fonts/${id}/static.json`)
      .then((r) => (r.ok ? (r.json() as Promise<{ files: Record<string, string> }>) : null))
      .then((body) => body?.files ?? null)
      .catch(() => null);
    statics.set(id, hit);
  }
  return hit;
}

async function load(server: string, face: NativeFace): Promise<void> {
  const named = faceName(face);
  if (!named || loaded.has(named.name)) return;
  let job = loading.get(named.name);
  if (!job) {
    job = (async () => {
      const files = await staticFiles(server, named.id);
      // The weight asked, else the regular face's weight in the same slant, else any face the family has.
      const path = files?.[named.key] ?? files?.[named.key.replace(/\d+/, "400")] ?? Object.values(files ?? {})[0];
      if (!path) return;
      await Font.loadAsync({ [named.name]: { uri: `${server}${path}` } });
      loaded.add(named.name);
      for (const fn of listeners) fn();
    })().catch(() => {});
    loading.set(named.name, job);
  }
  await job;
}

/** How a face is set: its own registered name once loaded, else the system's font at its weight. */
export function faceStyle(face: NativeFace): TextStyle {
  const named = faceName(face);
  if (named && loaded.has(named.name)) return { fontFamily: named.name, fontWeight: "normal", fontStyle: "normal" };
  return { fontWeight: weightStyle(face.weight), ...(face.italic ? { fontStyle: "italic" } : {}) };
}

/** Loads the faces a piece of text draws with, and draws it again as each one arrives. */
export function useNativeFaces(faces: readonly NativeFace[]): void {
  const server = useServer();
  const [, bump] = useState(0);
  const key = faces.map((f) => `${f.ref}:${f.weight}:${f.italic}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `faces` as a value
  useEffect(() => {
    if (!server) return;
    const missing = faces.filter((f) => {
      const named = faceName(f);
      return named && !loaded.has(named.name);
    });
    if (!missing.length) return;
    let alive = true;
    const fn = () => {
      if (alive) bump((n) => n + 1);
    };
    listeners.add(fn);
    for (const f of missing) void load(server, f);
    return () => {
      alive = false;
      listeners.delete(fn);
    };
  }, [key, server]);
}
