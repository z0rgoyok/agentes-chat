import { afterEach, expect, test } from "bun:test";
import { createRequester } from "../src/index";

/** The platform's `XMLHttpRequest` as far as an upload uses it: the test sends progress, then answers or fails. */
class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  statusText = "";
  responseText = "";
  withCredentials = false;
  headers: Record<string, string> = {};
  sent: string | null = null;
  url = "";
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: string) {
    this.sent = body;
    FakeXhr.last = this;
  }
  abort() {
    this.onabort?.();
  }
}

const g = globalThis as { XMLHttpRequest?: unknown };
const real = g.XMLHttpRequest;
afterEach(() => {
  g.XMLHttpRequest = real;
  FakeXhr.last = null;
});

test("a write that asks for its progress hears how much of its body went, and the server's answer", async () => {
  g.XMLHttpRequest = FakeXhr;
  const sent: number[] = [];
  const answer = createRequester()<{ id: string }>("/api/app/x", {
    json: { zipBase64: "UEsDBA==" },
    onUploadProgress: (s) => sent.push(s),
  });
  const xhr = FakeXhr.last as unknown as FakeXhr;
  expect(xhr.sent).toBe(JSON.stringify({ zipBase64: "UEsDBA==" }));
  expect(xhr.headers["content-type"]).toBe("application/json");
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
  xhr.status = 200;
  xhr.responseText = JSON.stringify({ id: "s1" });
  xhr.onload?.();
  expect(await answer).toEqual({ id: "s1" });
  expect(sent).toEqual([0.25, 1]);
});

test("Cancel stops the upload: its request aborts and the caller hears an AbortError", async () => {
  g.XMLHttpRequest = FakeXhr;
  const stop = new AbortController();
  const answer = createRequester()("/api/app/x", { json: {}, signal: stop.signal, onUploadProgress: () => {} });
  stop.abort();
  expect(await answer.catch((e: Error) => e.name)).toBe("AbortError");
});

test("with no XMLHttpRequest the write goes by fetch, still stoppable", async () => {
  g.XMLHttpRequest = undefined;
  let signal: AbortSignal | undefined;
  const fetch = (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      signal = init.signal ?? undefined;
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const stop = new AbortController();
  const answer = createRequester({ fetch })("/api/app/x", {
    json: {},
    signal: stop.signal,
    onUploadProgress: () => {},
  });
  stop.abort();
  expect(await answer.catch((e: Error) => e.name)).toBe("AbortError");
  expect(signal).toBe(stop.signal);
});
