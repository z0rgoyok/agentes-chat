import { afterEach, describe, expect, test } from "bun:test";
import { newClientId } from "../src/api/queries";
import { INSECURE_CONTEXT, sealSecret } from "../src/lib/secret-box";
import { secretRefusalKey } from "../src/lib/secret-requests";

const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");

/** What a page at a plain-http address gets: random bytes, but no `subtle` and no `randomUUID`. */
const plainHttp = () =>
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: (a: Uint8Array) => real?.value.getRandomValues(a) ?? a },
  });

afterEach(() => {
  if (real) Object.defineProperty(globalThis, "crypto", real);
});

describe("on a plain-http page", () => {
  test("sealing says the page isn't secure, not that the network dropped", async () => {
    plainHttp();
    const error = await sealSecret("AAAA", "code", "aad").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ code: INSECURE_CONTEXT });
    expect(secretRefusalKey(error)).toBe("secret.insecureContext");
  });

  test("a new client id is still a v4 UUID", () => {
    plainHttp();
    expect(newClientId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("with no crypto at all (the phone's engine) a send still gets a v4 UUID, never an error", () => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    const ids = new Set(Array.from({ length: 50 }, () => newClientId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
