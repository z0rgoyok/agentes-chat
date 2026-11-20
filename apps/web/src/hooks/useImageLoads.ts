import { useEffect, useState } from "react";

/** Whether the image at `url` loads: a missing file (or the app's page served in its place) never does. */
export function useImageLoads(url: string | null): boolean {
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => setLoaded(url);
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [url]);
  return url !== null && loaded === url;
}
