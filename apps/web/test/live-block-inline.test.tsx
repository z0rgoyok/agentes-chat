import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { ArtifactViewerProvider } from "@/components/artifacts/ArtifactViewer";
import { LiveBlock, LiveBlockCard } from "@/components/blocks/LiveBlock";
import { ADA_ID, createFakeApi, ORG_ID } from "./fake-api";
import { onScreen, renderPage, screen, settle } from "./render";

test("opening a visible inline HTML block mounts its frame", async () => {
  const restore = onScreen("*");
  try {
    await renderPage(
      <LiveBlock id="inline-page" version={1} title="Stage report" html="<p>Done</p>" agentId={ADA_ID} />,
      {
        api: createFakeApi(),
        org: true,
      },
    );
    expect(screen().queryByTitle("Stage report")).toBeNull();
    fireEvent.click(screen().getByRole("button", { name: "Abrir bloco" }));
    expect((await screen().findByTitle("Stage report")).tagName).toBe("IFRAME");
  } finally {
    cleanup();
    restore();
  }
});

test("the person's action is available on the inline card before its HTML runs", async () => {
  const api = createFakeApi();
  const [first] = await api.artifacts.list(ORG_ID);
  if (!first) throw new Error("missing fixture");
  const file = await api.artifacts.get(ORG_ID, first.id);
  const calls: unknown[][] = [];
  api.artifacts.get = async () => ({
    ...file,
    kind: "block",
    content: { kind: "block", html: "<p>Work</p>" },
    blockActions: calls.length ? [] : [{ id: "report-1", label: "Accept report" }],
  });
  api.artifacts.invokeBlockAction = async (...input) => void calls.push(input);
  try {
    await renderPage(
      <ArtifactViewerProvider>
        <LiveBlockCard id={file.id} version={file.shownVersion} />
      </ArtifactViewerProvider>,
      { api, org: true },
    );
    const action = await screen().findByRole("button", { name: "Accept report" });
    expect(action.closest("section.live-block")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(action);
    await settle();
    expect(calls).toEqual([[ORG_ID, file.id, file.shownVersion, "report-1"]]);
    expect(screen().queryByRole("button", { name: "Accept report" })).toBeNull();
  } finally {
    cleanup();
  }
});

test("a card that was opened stays open when a trusted revision replaces it", async () => {
  const restore = onScreen("*");
  const api = createFakeApi();
  const [first] = await api.artifacts.list(ORG_ID);
  if (!first) throw new Error("missing fixture");
  const file = await api.artifacts.get(ORG_ID, first.id);
  const delayed = Promise.withResolvers<void>();
  api.artifacts.get = async (_org, id, version) => {
    if (id === file.id && version === 2) await delayed.promise;
    return {
      ...file,
      id,
      kind: "block",
      content: { kind: "block", html: `<p>Revision ${version}</p>` },
      shownVersion: version ?? 1,
      title: `Revision ${version}`,
      ...(id === file.id ? { rememberBlockOpen: true as const } : {}),
    };
  };
  function Card({ id }: { id: string }) {
    const [version, setVersion] = useState(1);
    return (
      <ArtifactViewerProvider>
        <button type="button" onClick={() => setVersion(2)}>
          Update card
        </button>
        <LiveBlockCard id={id} version={version} />
      </ArtifactViewerProvider>
    );
  }
  const update = () => fireEvent.click(screen().getByRole("button", { name: "Update card" }));
  const open = () => screen().findByRole("button", { name: "Abrir bloco" });
  try {
    await renderPage(<Card id={file.id} />, { api, org: true });
    fireEvent.click(await open());
    await screen().findByTitle("Revision 1");

    update();
    await settle();
    expect(screen().queryByTitle("Revision 1")?.tagName).toBe("IFRAME");
    delayed.resolve();
    await screen().findByText("Revision 2");
    expect(screen().queryByRole("button", { name: "Abrir bloco" }) !== null).toBe(false);
    await screen().findByTitle("Revision 2");

    cleanup();
    await renderPage(<Card id="another-block" />, { api, org: true });
    fireEvent.click(await open());
    await screen().findByTitle("Revision 1");

    update();
    await screen().findByText("Revision 2");
    await screen().findByRole("button", { name: "Abrir bloco" });
    expect(screen().queryByTitle("Revision 2")).toBeNull();
  } finally {
    cleanup();
    restore();
  }
});
