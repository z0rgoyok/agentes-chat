import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useVoiceRecorder } from "../src/components/voice-recorder";
import { fakeMicrophone } from "../testing/microphone";

let restore = () => {};
afterEach(() => {
  cleanup();
  restore();
});

function Recorder({ onRecording }: { onRecording: () => void }) {
  const wave = useRef<HTMLCanvasElement | null>(null);
  const rec = useVoiceRecorder({ onTake: () => {}, onNotice: () => {}, onRecording }, wave);
  return (
    <div>
      <button type="button" {...rec.micProps}>
        Gravar
      </button>
      <button type="button" onClick={rec.togglePause}>
        Pausar
      </button>
      <output>{rec.phase}</output>
    </div>
  );
}

const wait = (ms: number) => act(() => Bun.sleep(ms));

test("“gravando áudio…”: told when it starts and each second it records, never while paused", async () => {
  restore = fakeMicrophone();
  let told = 0;
  render(<Recorder onRecording={() => told++} />);
  expect(told).toBe(0);
  // A click (no hold) records hands free.
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole("button", { name: "Gravar" }), { button: 0 });
    fireEvent.pointerUp(window);
  });
  await wait(100);
  expect(screen.getByRole("status").textContent).toBe("rec");
  const started = told;
  expect(started).toBeGreaterThan(0);
  await wait(1100);
  expect(told).toBeGreaterThan(started);
  // Paused: nothing, however long.
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pausar" })));
  expect(screen.getByRole("status").textContent).toBe("paused");
  const paused = told;
  await wait(1200);
  expect(told).toBe(paused);
  // Going on tells it again at once.
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pausar" })));
  await wait(50);
  expect(told).toBeGreaterThan(paused);
}, 10_000);
