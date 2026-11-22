import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, fireEvent } from "@testing-library/react";
import { LiveBlock } from "@/components/blocks/LiveBlock";
import { ADA_ID, createFakeApi } from "./fake-api";
import { onScreen, renderPage, screen } from "./render";

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
