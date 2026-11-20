import { FilterMode, ImageFormat, MipmapMode, type SkImage, Skia } from "@shopify/react-native-skia";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { appHeaders, readCookie } from "@/lib/auth";
import { photoSource } from "@/lib/photo";
import { serverUrl } from "@/lib/server";
import { PHOTO_MAX_BASE64 } from "../me/logic";
import { shrunkSize, type WallpaperTarget } from "./wallpaper-logic";

/**
 * A photo as a conversation's background: read from the server once (behind the session, as the avatars are) and
 * kept decoded for Skia while the app runs; and the one the person just picked, shrunk on the phone before it is sent.
 */

/** Photos decoded, by address: a few at most (each is a full screen of pixels). */
const decoded = new Map<string, SkImage>();
const loading = new Map<string, Promise<SkImage | null>>();
const KEEP = 3;

function keep(url: string, image: SkImage) {
  decoded.delete(url);
  decoded.set(url, image);
  while (decoded.size > KEEP) {
    const oldest = decoded.keys().next().value;
    if (oldest === undefined) break;
    decoded.delete(oldest);
    loading.delete(oldest);
  }
}

/** The photo just sent, drawn from the phone's own copy: the conversation shows it without reading it back. */
export function rememberWallpaperPhoto(url: string, image: SkImage) {
  keep(url, image);
  loading.set(url, Promise.resolve(image));
}

/** A background photo's pixels, read once with the session (`/api/app/wallpapers/…`); null when it can't be read. */
export function loadWallpaperPhoto(url: string): Promise<SkImage | null> {
  const hit = loading.get(url);
  if (hit) return hit;
  const read = (async () => {
    const src = photoSource(url, serverUrl(), appHeaders(await readCookie()));
    if (!src) return null;
    const res = await fetch(src.uri, src.headers ? { headers: src.headers } : undefined);
    if (!res.ok) return null;
    const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(new Uint8Array(await res.arrayBuffer())));
    if (image) keep(url, image);
    return image;
  })().catch(() => null);
  loading.set(url, read);
  // A failure is forgotten: the next look tries again.
  void read.then((image) => {
    if (!image && loading.get(url) === read) loading.delete(url);
  });
  return read;
}

/** The photo at `url` once it is read (null before, and for no photo). */
export function useWallpaperPhoto(url: string | null): SkImage | null {
  const [image, setImage] = useState<{ url: string; image: SkImage } | null>(() => {
    const hit = url ? decoded.get(url) : undefined;
    return url && hit ? { url, image: hit } : null;
  });
  useEffect(() => {
    if (!url) return;
    const hit = decoded.get(url);
    if (hit) {
      setImage((now) => (now?.url === url && now.image === hit ? now : { url, image: hit }));
      return;
    }
    let alive = true;
    void loadWallpaperPhoto(url).then((read) => {
      if (alive && read) setImage({ url, image: read });
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return url && image?.url === url ? image.image : null;
}

/** A photo picked for a background, ready to send: shrunk, as JPEG, and decoded for the preview. */
export interface PickedPhoto {
  image: SkImage;
  base64: string;
  contentType: "image/jpeg";
  /** Whose background it becomes. */
  target: WallpaperTarget;
}

/** The photo between the picker and its preview (too big for a route's params); one at a time. */
let picked: PickedPhoto | null = null;
export const pickedWallpaperPhoto = () => picked;
export const setPickedWallpaperPhoto = (next: PickedPhoto | null) => {
  picked = next;
};

/**
 * The system's photo library (images only), then the photo shrunk to `PHOTO_MAX_SIDE` on its long side and encoded
 * as JPEG (lighter if it is still over the server's 2 MB). Null when the person cancels; "failed" when the photo
 * can't be read.
 */
export async function pickWallpaperPhoto(target: WallpaperTarget): Promise<PickedPhoto | null | "failed"> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: false,
    // Under 1 the system hands a JPEG back, which every phone decodes (never a format Skia may not read).
    quality: 0.9,
  });
  const asset = res.canceled ? null : res.assets[0];
  if (!asset) return null;
  try {
    const source = Skia.Image.MakeImageFromEncoded(await Skia.Data.fromURI(asset.uri));
    if (!source) return "failed";
    const size = shrunkSize(source.width(), source.height());
    const surface = Skia.Surface.Make(size.width, size.height);
    if (!surface) return "failed";
    surface
      .getCanvas()
      .drawImageRectOptions(
        source,
        Skia.XYWHRect(0, 0, source.width(), source.height()),
        Skia.XYWHRect(0, 0, size.width, size.height),
        FilterMode.Linear,
        MipmapMode.Linear,
        null,
      );
    surface.flush();
    const shot = surface.makeImageSnapshot();
    let base64 = shot.encodeToBase64(ImageFormat.JPEG, 85);
    if (base64.length > PHOTO_MAX_BASE64) base64 = shot.encodeToBase64(ImageFormat.JPEG, 65);
    if (!base64 || base64.length > PHOTO_MAX_BASE64) return "failed";
    // Decoded again from the JPEG itself: what the preview shows is what is sent, in memory any thread may draw.
    const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBase64(base64));
    return image ? { image, base64, contentType: "image/jpeg", target } : "failed";
  } catch {
    return "failed";
  }
}
