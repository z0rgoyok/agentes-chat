import { firstWords, type SpeechEngine } from "@agenteschat/adapters";
import { clockOf } from "./format";

/**
 * `review_media`: a video or a recording on the agent's computer as a reviewer takes it in, made there with ffmpeg:
 * frames spread across all of it (or a stretch) and what is said, transcribed by the server's speech engines in
 * stretches cut at pauses, each with its times.
 */

export const REVIEW_FRAMES_MAX = 40;
/** The most of a recording one call transcribes: past it, the agent asks for the next stretch. */
export const REVIEW_AUDIO_SECONDS = 20 * 60;
/** A transcribed stretch's length, moved to the middle of a pause within `SNAP_SECONDS` so no word is cut. */
const STRETCH_SECONDS = 20;
const SNAP_SECONDS = 6;
/** Frames' longer side: on-screen text stays legible at a few hundred tokens a frame. */
const FRAME_SIDE = 768;
const TRANSCRIBE_AT_ONCE = 4;

export interface MediaProbe {
  /** Seconds; null where the container doesn't say (some recordings in WebM). */
  duration: number | null;
  /** A picture track: a cover image in an audio file is not one. */
  video: boolean;
  audio: boolean;
}

/** `$1` the file, `$2`/`$3` where the pauses are looked for. Says `no-ffmpeg` or `no-file` instead when so. */
export const PROBE_SCRIPT = [
  "f=$1",
  "command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 || { echo no-ffmpeg; exit 0; }",
  '[ -f "$f" ] || { echo no-file; exit 0; }',
  'echo "duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"',
  'echo "video=$(ffprobe -v error -select_streams V -show_entries stream=index -of csv=p=0 "$f" | head -n 1)"',
  'echo "audio=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$f" | head -n 1)"',
  'ffmpeg -nostdin -hide_banner -nostats -i "$f" -vn -af "atrim=start=$2:end=$3,silencedetect=n=-35dB:d=0.3" -f null - 2>&1 | grep -E "silence_(start|end)"',
  "exit 0",
].join("\n");

export function parseProbe(stdout: string): MediaProbe {
  const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(stdout)?.[1]?.trim() ?? "";
  const duration = Number.parseFloat(field("duration"));
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    video: field("video") !== "",
    audio: field("audio") !== "",
  };
}

/** silencedetect's pauses, in seconds of the file; one still open at the end closes at `end`. */
export function parseSilences(stdout: string, end: number): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  for (const m of stdout.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const t = Number.parseFloat(m[2] ?? "");
    if (!Number.isFinite(t)) continue;
    if (m[1] === "start") start = Math.max(0, t);
    else if (start !== null) {
      out.push([start, t]);
      start = null;
    }
  }
  if (start !== null) out.push([start, end]);
  return out;
}

/** `n` moments spread evenly across `from`–`to`, each in the middle of its share. */
export const frameTimes = (from: number, to: number, n: number) =>
  Array.from({ length: n }, (_, i) => from + ((i + 0.5) * (to - from)) / n);

/** About `STRETCH_SECONDS` each, cut in the middle of the pause nearest each mark when there is one close by. */
export function speechStretches(from: number, to: number, silences: [number, number][]): [number, number][] {
  const cuts = [from];
  let at = from;
  while (to - at > STRETCH_SECONDS + SNAP_SECONDS) {
    const mark = at + STRETCH_SECONDS;
    let cut = mark;
    let gap = SNAP_SECONDS;
    for (const [s, e] of silences) {
      const mid = (s + e) / 2;
      if (mid > at + 1 && Math.abs(mid - mark) <= gap) {
        cut = mid;
        gap = Math.abs(mid - mark);
      }
    }
    cuts.push(cut);
    at = cut;
  }
  cuts.push(to);
  return cuts.slice(1).map((end, i) => [cuts[i] as number, end]);
}

/** A stretch that is all pause: never sent, since speech models make up words for silence. */
export const isSilent = ([a, b]: [number, number], silences: [number, number][]) =>
  silences.some(([s, e]) => s <= a + 0.5 && e >= b - 0.5);

export const frameFile = (i: number) => `f${String(i).padStart(2, "0")}.jpg`;
export const audioFile = (i: number) => `a${String(i).padStart(2, "0")}.m4a`;

/** `$1` the file, `$2` the folder: a JPEG per moment and an AAC file per stretch (ffmpeg's own encoders). */
export function extractScript(frames: number[], stretches: [number, number][]): string {
  const scale = `scale='if(gt(iw,ih),min(${FRAME_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${FRAME_SIDE},ih))'`;
  return [
    "f=$1 o=$2",
    'mkdir -p "$o" || exit 1',
    ...frames.map(
      (t, i) =>
        `ffmpeg -nostdin -v error -y -ss ${t.toFixed(3)} -i "$f" -frames:v 1 -vf "${scale}" -q:v 5 "$o/${frameFile(i)}"`,
    ),
    ...stretches.map(
      ([a, b], i) =>
        `ffmpeg -nostdin -v error -y -ss ${a.toFixed(3)} -i "$f" -t ${(b - a).toFixed(3)} -vn -ac 1 -ar 16000 -c:a aac -b:a 32k "$o/${audioFile(i)}"`,
    ),
    "exit 0",
  ].join("\n");
}

/** One line per stretch, `[0:20–0:41] words`, in order; a stretch that fails says so on its line. */
export async function transcriptLines(
  engines: SpeechEngine[],
  stretches: [number, number][],
  silences: [number, number][],
  audioOf: (i: number) => Promise<Uint8Array | null>,
  orgId: string,
): Promise<string[]> {
  const lines: string[] = new Array(stretches.length).fill("");
  let next = 0;
  const work = async () => {
    for (let i = next++; i < stretches.length; i = next++) {
      const stretch = stretches[i] as [number, number];
      const at = `[${clockOf(stretch[0])}–${clockOf(stretch[1])}]`;
      if (isSilent(stretch, silences)) {
        lines[i] = `${at} (silence)`;
        continue;
      }
      try {
        const audio = await audioOf(i);
        if (!audio) {
          lines[i] = `${at} (its sound couldn't be cut out)`;
          continue;
        }
        const durationMs = Math.round((stretch[1] - stretch[0]) * 1000);
        const input = { audio, contentType: "audio/mp4", language: null, terms: [], orgId, durationMs };
        const words = await firstWords(engines, input, 30_000);
        lines[i] = `${at} ${words === null ? "(the speech service refused it)" : words.text || "(no words made out)"}`;
      } catch (error) {
        lines[i] = `${at} (couldn't be transcribed: ${error instanceof Error ? error.message : String(error)})`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRANSCRIBE_AT_ONCE, stretches.length) }, work));
  return lines;
}
