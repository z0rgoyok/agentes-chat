import type { AgentAppearance } from "@agenteschat/ui";
import { bodyTones, drawAccessory, drawAgent, inBody, toneAt } from "@agenteschat/ui/agent/engine";

/**
 * A workspace's agent as the app icon (ADR 0179): the Night icon's sky (`/app-icons/night-sky.png`, written by
 * packages/ui/scripts/app-icons.mjs without its agent) with the agent drawn by the agent engine in its own look, on
 * the sky's cells as the shipped icon's. The tab's icon is drawn pixel by pixel like the shipped favicons, without
 * the accessory (at 16 px it is noise). The desktop app can't draw: it is sent the Dock's and the windows' pictures.
 */
export interface AgentIcon {
  orgId: string;
  id: string;
  name: string;
  look: AgentAppearance;
}

const NAVY_TILE = "#06192f";
const SKY = "/app-icons/night-sky.png";
let sky: Promise<HTMLImageElement | null> | null = null;
function nightSky() {
  sky ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = SKY;
  });
  return sky;
}

function canvas(px: number) {
  const c = document.createElement("canvas");
  c.width = c.height = px;
  return c;
}

/** The icon's square scene at `px`: the sky, then the agent (with an accessory, smaller and lower so it fits). */
async function scene(px: number, look: AgentAppearance) {
  const c = canvas(px);
  const g = c.getContext("2d");
  if (!g) return c;
  g.imageSmoothingEnabled = false;
  const img = await nightSky();
  if (img) g.drawImage(img, 0, 0, px, px);
  else {
    g.fillStyle = NAVY_TILE;
    g.fillRect(0, 0, px, px);
  }
  const u = px / 1024;
  const accessory = look.accessory && look.accessory !== "none" ? look.accessory : undefined;
  // On the sky's 32 cells: 576 (18 cells) from (224, 192) as the shipped icon; with an accessory 512 (16) from (256, 416).
  const [x, y, s, cells] = accessory ? [256, 416, 512, 16] : [224, 192, 576, 18];
  drawAgent(g, x * u, y * u, s * u, {
    color: look.color,
    eyes: look.eyes,
    cells,
    after: accessory ? (ctx, side, frame) => drawAccessory(ctx, side, accessory, frame) : undefined,
  });
  return c;
}

/** The picker's and the row's picture (a square; CSS rounds it like the others). */
export async function agentIconPicture(look: AgentAppearance, px = 160) {
  return (await scene(px, look)).toDataURL("image/png");
}

/** The tab's icon at 16 or 32: a navy tile, the body in flat bands (16) or the dither (32), eyes on whole pixels. */
export function agentFavicon(look: AgentAppearance, N: 16 | 32 = 32) {
  const c = canvas(N);
  const g = c.getContext("2d");
  if (!g) return "";
  g.fillStyle = NAVY_TILE;
  g.beginPath();
  g.roundRect(0, 0, N, N, N === 16 ? 3.5 : 7);
  g.fill();
  const tones = bodyTones(look.color);
  const [at, side] = N === 16 ? [2, 12] : [5, 22];
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      if (!inBody((x + 0.5) / side, (y + 0.5) / side)) continue;
      const tone = N === 16 ? ([4, 3, 2][Math.min(2, Math.floor(y / 4))] ?? 2) : toneAt(x >> 1, y >> 1, side / 2);
      g.fillStyle = tones[tone] ?? tones[2] ?? NAVY_TILE;
      g.fillRect(at + x, at + y, 1, 1);
    }
  g.fillStyle = "#ffffff";
  if (N === 16) {
    g.fillRect(6, 6, 1, 4);
    g.fillRect(9, 6, 1, 4);
  } else {
    g.fillRect(12, 12, 2, 6);
    g.fillRect(18, 12, 2, 6);
  }
  return c.toDataURL("image/png");
}

/** macOS's shape on Apple's grid (as the generator's `macLayers`): a superellipse of 824 at 100, a soft shadow under. */
function squircle(g: CanvasRenderingContext2D, px: number) {
  const u = px / 1024;
  const a = 412 * u;
  const c = 512 * u;
  g.beginPath();
  for (let i = 0; i <= 360; i++) {
    const t = (i / 360) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = c + a * Math.sign(cos) * Math.abs(cos) ** (2 / 5);
    const y = c + a * Math.sign(sin) * Math.abs(sin) ** (2 / 5);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

const base64Of = (c: HTMLCanvasElement) => c.toDataURL("image/png").slice("data:image/png;base64,".length);

/** The pictures the desktop app keeps for an agent: the Dock's (512, macOS's shape) and the windows' (256, rounded). */
export async function agentDesktopPictures(look: AgentAppearance) {
  const art = await scene(1024, look);
  const dock = canvas(512);
  const d = dock.getContext("2d");
  if (d) {
    const u = 512 / 1024;
    d.save();
    squircle(d, 512);
    d.shadowColor = "rgba(0, 0, 0, 0.3)";
    d.shadowBlur = 26 * u;
    d.shadowOffsetY = 10 * u;
    d.fillStyle = NAVY_TILE;
    d.fill();
    d.restore();
    squircle(d, 512);
    d.clip();
    d.drawImage(art, 100 * u, 100 * u, 824 * u, 824 * u);
  }
  const window = canvas(256);
  const w = window.getContext("2d");
  if (w) {
    w.beginPath();
    w.roundRect(0, 0, 256, 256, 256 * 0.22);
    w.clip();
    w.drawImage(art, 0, 0, 256, 256);
  }
  return { dock: base64Of(dock), window: base64Of(window) };
}

/** Whether two looks draw the same agent (a name or look changed on the server redraws the icon). */
export const sameAgent = (a: AgentIcon, b: AgentIcon) =>
  a.name === b.name &&
  (a.look.color ?? "") === (b.look.color ?? "") &&
  (a.look.eyes ?? "") === (b.look.eyes ?? "") &&
  (a.look.accessory ?? "") === (b.look.accessory ?? "");
