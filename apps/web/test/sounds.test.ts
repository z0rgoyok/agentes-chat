import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

/** Web Audio as far as the app's sounds use it: counts what starts, resumes and suspends. */
class FakeAudio {
  static made: FakeAudio[] = [];
  state: "suspended" | "running" = "suspended";
  currentTime = 0;
  destination = {};
  started = 0;
  resumes = 0;
  suspends = 0;
  constructor() {
    FakeAudio.made.push(this);
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const audio = this;
    return {
      buffer: null,
      connect() {},
      start() {
        audio.started++;
      },
    };
  }
  resume() {
    this.resumes++;
    this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    this.suspends++;
    this.state = "suspended";
    return Promise.resolve();
  }
}
(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudio;

const { installSounds } = await import("../src/lib/sounds");
const { playSound } = await import("@agenteschat/client/lib/sounds");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("audio is on only to play: off a moment after the last sound, on again for the next one", async () => {
  installSounds();
  // Before the person's first click or key nothing plays.
  playSound("mention");
  const audio = FakeAudio.made[0];
  expect(audio?.started).toBe(0);
  window.dispatchEvent(new Event("pointerdown"));
  await wait(0);
  expect(audio?.state).toBe("running");
  // Nothing to play yet: the device is let go.
  await wait(1600);
  expect(audio?.state).toBe("suspended");
  expect(audio?.suspends).toBe(1);
  // A sound turns it on again and plays, then it goes off once the sound is over.
  playSound("reply");
  await wait(0);
  expect(audio?.state).toBe("running");
  expect(audio?.started).toBe(1);
  // A sound lasts under 1.6 s (sfx.test.ts), then 1.5 s more.
  await wait(3300);
  expect(audio?.state).toBe("suspended");
  expect(audio?.suspends).toBe(2);
  expect(FakeAudio.made).toHaveLength(1);
}, 10_000);
