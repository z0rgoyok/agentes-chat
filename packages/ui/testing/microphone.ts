/**
 * A microphone for tests that record (happy-dom has none): `getUserMedia`, `AudioContext` and `MediaRecorder`, enough
 * for the kit's recorder to record, pause, go on and stop. On `window` and on the globals alike (the DOM's are copies
 * there, `testing/dom.ts`). Returns the way back to what was there.
 */
export function fakeMicrophone() {
  class Recorder {
    static isTypeSupported = () => true;
    state: "inactive" | "recording" | "paused" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
    pause() {
      this.state = "paused";
    }
    resume() {
      this.state = "recording";
    }
    requestData() {
      this.ondataavailable?.({ data: new Blob(["voice"]) });
    }
    stop() {
      this.requestData();
      this.state = "inactive";
      this.onstop?.();
    }
  }
  class Context {
    currentTime = 0;
    destination = {};
    resume = async () => {};
    close = async () => {};
    // Someone speaking: never the silence a take is dropped for.
    createAnalyser = () => ({ fftSize: 1024, getFloatTimeDomainData: (buf: Float32Array) => buf.fill(0.2) });
    createMediaStreamSource = () => ({ connect: () => {} });
  }
  const devices = { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) };
  const fakes: [object, string, unknown][] = [
    ...[window, globalThis].flatMap((on): [object, string, unknown][] => [
      [on, "MediaRecorder", Recorder],
      [on, "AudioContext", Context],
    ]),
    [navigator, "mediaDevices", devices],
  ];
  const had = fakes.map(([on, name]) => Object.getOwnPropertyDescriptor(on, name));
  for (const [on, name, value] of fakes) Object.defineProperty(on, name, { configurable: true, value });
  return () =>
    fakes.forEach(([on, name], i) => {
      const was = had[i];
      if (was) Object.defineProperty(on, name, was);
      else Reflect.deleteProperty(on, name);
    });
}
