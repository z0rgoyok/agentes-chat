import { expect, test } from "bun:test";
import { createDatabase } from "../src/client";

test("the server's pool starts its sessions with JIT off; the URL may turn it back on", async () => {
  // postgres.js connects on the first query: none is sent here.
  const plain = createDatabase({ url: "postgres://u:p@127.0.0.1:1/x", poolMax: 1 });
  const on = createDatabase({ url: "postgres://u:p@127.0.0.1:1/x?jit=on", poolMax: 1 });
  try {
    expect(plain.client?.options.connection).toMatchObject({ jit: "off" });
    expect(on.client?.options.connection).toMatchObject({ jit: "on" });
  } finally {
    await plain.close();
    await on.close();
  }
});

test("each process's connections carry its name, its LISTEN's and migrations' marked apart; the URL's wins", async () => {
  const named = createDatabase({
    url: "postgres://u:p@127.0.0.1:1/x",
    poolMax: 1,
    applicationName: "agentes:worker:h1",
  });
  const plain = createDatabase({ url: "postgres://u:p@127.0.0.1:1/x", poolMax: 1 });
  const url = createDatabase({
    url: "postgres://u:p@127.0.0.1:1/x?application_name=mine",
    poolMax: 1,
    applicationName: "x",
  });
  const listen = named.listenClient?.();
  try {
    expect(named.client?.options.connection).toMatchObject({ application_name: "agentes:worker:h1" });
    expect(listen?.options.connection).toMatchObject({ application_name: "agentes:worker:h1:listen" });
    expect(plain.client?.options.connection).toMatchObject({ application_name: "agentes" });
    expect(url.client?.options.connection).toMatchObject({ application_name: "mine" });
  } finally {
    await Promise.all([named.close(), plain.close(), url.close(), listen?.end()]);
  }
});
