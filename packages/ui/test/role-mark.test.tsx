import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { RoleMark } from "../src/components/RoleMark";

afterEach(cleanup);

test("a role's mark keeps its icon proportionate at every size, down to the smallest a list uses", () => {
  for (const size of [14, 16, 18, 20, 24, 26, 32, 40, 64]) {
    const { container } = render(<RoleMark color="violet" icon="shield" size={size} />);
    const mark = container.querySelector(".ac-rolemark") as HTMLElement;
    const icon = mark.querySelector("svg") as SVGElement;
    expect([size, mark.style.width]).toEqual([size, `${size}px`]);
    // The kit's icons draw 20px unless told otherwise.
    const glyph = Number.parseFloat(icon.style.width || "20");
    expect([size, glyph / size <= 0.72]).toEqual([size, true]);
    cleanup();
  }
});
