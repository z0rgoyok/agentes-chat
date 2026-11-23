import { describe, expect, test } from "bun:test";
import { fakeImagePng } from "@agenteschat/providers/testing";
import { looksLikeSvg, rasterPicture, SVG_LIMITS, SVG_TYPE, sanitizeSvg, setSvgRasterizer } from "../src";

/**
 * SVG pictures in live files (ADR 0196 §8): what the sanitizer keeps (shapes, paths, text, gradients, references inside
 * the picture) and what it takes out or refuses, from a corpus of hostile SVGs: scripts, handlers, foreignObject,
 * outside references, entity bombs, `<use>` bombs, huge paths, deep nesting.
 */

const svg = (body: string, attrs = 'viewBox="0 0 24 24"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

/** The clean text, and that it holds none of what may run or load. */
function clean(text: string) {
  const out = sanitizeSvg(text);
  expect(out.svg).not.toMatch(
    /<script|<foreignObject|<image|<iframe|<animate|<set\b|\son\w+=|javascript:|https?:\/\/(?!www\.w3\.org)/i,
  );
  // What it wrote reads back the same: the sanitizer is stable on its own output.
  expect(sanitizeSvg(out.svg).svg).toBe(out.svg);
  return out;
}

const refusedWith = (text: string, why: RegExp) => {
  let error: unknown;
  try {
    sanitizeSvg(text);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe("live.svg_invalid");
  expect((error as Error).message).toMatch(why);
};

describe("sanitizeSvg: what a drawing keeps", () => {
  test("an icon: shapes, paths, a gradient by reference, text, its title; written with its size and viewBox", () => {
    const out = clean(
      svg(
        '<title>A computer</title><defs><linearGradient id="g"><stop offset="0" stop-color="#0063d1"/><stop offset="1" stop-color="#7cc4ff"/></linearGradient></defs>' +
          '<rect x="2" y="3" width="20" height="13" rx="2" fill="url(#g)" stroke="#111" stroke-width="1.5"/>' +
          '<path d="M8 21h8M12 16v5" stroke="#111" stroke-linecap="round" style="fill:none;stroke-width:2"/>' +
          '<text x="12" y="11" text-anchor="middle" font-family="Inter, sans-serif" font-size="4">PC &amp; <tspan font-weight="700">co</tspan></text>',
      ),
    );
    expect(
      out.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 24 24"'),
    ).toBe(true);
    expect(out.svg).toContain('fill="url(#g)"');
    expect(out.svg).toContain('style="fill:none;stroke-width:2"');
    expect(out.svg).toContain("PC &amp; <tspan");
    expect(out).toMatchObject({ width: 512, height: 512, title: "A computer", removed: [] });
    expect(looksLikeSvg(out.bytes)).toBe(true);
  });

  test("natural size: absolute width and height (px, mm), else the viewBox's; tiny scaled up, huge scaled down", () => {
    expect(sanitizeSvg(svg("<rect/>", 'width="800" height="400"'))).toMatchObject({ width: 800, height: 400 });
    expect(sanitizeSvg(svg("<rect/>", 'width="800" viewBox="0 0 200 100"'))).toMatchObject({ width: 800, height: 400 });
    expect(sanitizeSvg(svg("<rect/>", 'viewBox="0 0 16 8"'))).toMatchObject({ width: 512, height: 256 });
    expect(sanitizeSvg(svg("<rect/>", 'viewBox="0 0 20000 10000"'))).toMatchObject({ width: 4096, height: 2048 });
    const a4 = sanitizeSvg(svg("<rect/>", 'width="210mm" height="297mm"'));
    expect(a4).toMatchObject({ width: 794, height: 1123 });
    expect(a4.svg).toContain('viewBox="0 0 793.701 1122.52"');
    // Percentages say nothing about a size: the viewBox does.
    expect(sanitizeSvg(svg("<rect/>", 'width="100%" height="100%" viewBox="0 0 600 300"'))).toMatchObject({
      width: 600,
      height: 300,
    });
  });

  test("written without xmlns, with an undeclared xlink, a bare DOCTYPE, an XML declaration, CDATA styles: still read", () => {
    const out = clean(
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' +
        '<svg viewBox="0 0 10 10"><style><![CDATA[ .a { fill: #e5484d } .b > .c { stroke: #111 } ]]></style>' +
        '<defs><circle id="dot" r="1" class="a"/></defs><use xlink:href="#dot" x="5" y="5"/></svg>',
    );
    expect(out.svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(out.svg).toContain('<use xlink:href="#dot" x="5" y="5"/>');
    expect(out.svg).toContain(".b &gt; .c");
    expect(out.removed).toEqual([]);
  });

  test("a prefixed root (svg:svg) and an editor's metadata: the drawing kept, the metadata left out silently", () => {
    const out = clean(
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 4 4" inkscape:version="1.3">' +
        '<svg:metadata>rdf</svg:metadata><inkscape:grid/><svg:rect width="4" height="4" inkscape:label="bg"/></svg:svg>',
    );
    expect(out.svg).toContain('<rect width="4" height="4"/>');
    expect(out.svg).not.toContain("inkscape");
    expect(out.removed).toEqual([]);
  });

  test("a link's words inside text stay text; the link goes", () => {
    const out = clean(svg('<text x="1" y="10"><a href="https://example.com">read more</a></text>'));
    expect(out.svg).toContain('<text x="1" y="10">read more</text>');
    expect(out.removed).toContain("links and outside references");
  });
});

describe("sanitizeSvg: what is taken out", () => {
  test("scripts, event handlers, foreignObject, animations and embedded pictures", () => {
    const out = clean(
      svg(
        '<script>alert(1)</script><script xlink:href="https://evil.example/x.js"/>' +
          '<rect width="4" height="4" onload="alert(1)" onclick="steal()" ONMOUSEOVER="x()"/>' +
          '<foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"/></body></foreignObject>' +
          '<a href="javascript:alert(1)"><circle r="2"/></a>' +
          '<set attributeName="href" to="javascript:alert(1)"/><animate attributeName="x" values="0;1" dur="1s"/>' +
          '<image href="https://evil.example/track.png" width="1" height="1"/><image href="data:image/png;base64,AAAA"/>' +
          '<filter id="f"><feImage href="https://evil.example/a.svg"/><feGaussianBlur stdDeviation="2"/></filter>',
      ),
    );
    expect(out.svg).toContain('<rect width="4" height="4"/>');
    expect(out.svg).toContain('<circle r="2"/>');
    expect(out.svg).toContain('<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>');
    expect(out.removed).toEqual(
      expect.arrayContaining([
        "scripts",
        "event handlers",
        "embedded HTML (foreignObject)",
        "links and outside references",
        "animations",
        "embedded or linked pictures",
      ]),
    );
  });

  test("outside references: in href, in url(), in CSS (@import, @font-face, url, escapes); inside ones stay", () => {
    const out = clean(
      svg(
        '<use href="https://evil.example/sprite.svg#icon"/><use href="#ok"/><g id="ok"><rect width="1" height="1"/></g>' +
          '<rect width="2" height="2" fill="url(https://evil.example/p.svg#x)" mask="url( \'#m\' )"/>' +
          '<rect width="3" height="3" style="fill:url(https://evil.example/a);stroke:red"/>' +
          '<rect width="5" height="5" style="behavior:url(x.htc);fill:blue"/>' +
          '<rect width="6" height="6" style="fill: red; -webkit-user-select: none; stroke: blue"/>' +
          '<rect width="7" height="7" fill="javascript:alert(1)" stroke="java&#x09;script:alert(1)"/>' +
          '<style>@import url("https://evil.example/x.css"); rect { fill: red }</style>' +
          "<style>@font-face { font-family: x; src: url(https://evil.example/f.woff) }</style>" +
          "<style>rect { background: \\75 rl(https://evil.example) }</style>" +
          "<style>rect { fill: url(https://evil.example/a) }</style>",
      ),
    );
    expect(out.svg).toContain('<use xlink:href="#ok"/>');
    expect(out.svg).not.toContain("sprite");
    expect(out.svg).toContain(`<rect width="2" height="2" mask="url( '#m' )"/>`);
    expect(out.svg).toContain('<rect width="3" height="3"/>');
    expect(out.svg).toContain('<rect width="5" height="5"/>');
    expect(out.svg).toContain('<rect width="6" height="6" style="fill:red;stroke:blue"/>');
    expect(out.svg).toContain('<rect width="7" height="7"/>');
    expect(out.svg).not.toContain("<style");
    expect(out.removed).toEqual(
      expect.arrayContaining([
        "links and outside references",
        "outside references",
        "outside references in CSS",
        "CSS that loads or runs",
        "CSS at-rules (@import, @font-face…)",
        "escaped CSS",
        "script or data addresses",
      ]),
    );
  });
});

describe("sanitizeSvg: what is refused", () => {
  test("entities: a billion laughs, an outside entity, an internal subset, an undefined one", () => {
    refusedWith(
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>&lol2;</text></svg>',
      /declares entities/,
    );
    refusedWith(
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>&xxe;</text></svg>',
      /declares entities/,
    );
    refusedWith(
      '<!DOCTYPE svg [<!ATTLIST svg onload CDATA "alert(1)">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      /document type declares/,
    );
    refusedWith(svg("<text>&nbsp;hi</text>"), /undefined entity/);
  });

  test("not an SVG, not XML, not text, no size", () => {
    refusedWith('<html><body><svg viewBox="0 0 1 1"/></body></html>', /root isn't an <svg>/);
    refusedWith(svg('<rect width="1"><g></rect>'), /well-formed/);
    refusedWith('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', /has no size/);
    expect(() => sanitizeSvg(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe]))).toThrow(/UTF-8/);
    refusedWith('<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 1 1"/>', /root isn't an <svg>/);
  });

  test("sizes: a huge path, too many elements, too deep, too much text, too many bytes", () => {
    refusedWith(svg(`<path d="M0 0${" L1 1".repeat(SVG_LIMITS.valueChars / 5 + 10)}"/>`), /d of a <path> is too long/);
    refusedWith(svg("<rect/>".repeat(SVG_LIMITS.elements + 10)), /over 10000 elements/);
    refusedWith(svg(`${"<g>".repeat(SVG_LIMITS.depth + 5)}<rect/>${"</g>".repeat(SVG_LIMITS.depth + 5)}`), /nest over/);
    refusedWith(svg(`<text>${"a".repeat(SVG_LIMITS.textChars + 1)}</text>`), /characters of text/);
    refusedWith(svg(`<desc>${"a".repeat(SVG_LIMITS.bytes)}</desc>`), /over 1000 KB/);
  });

  test("<use> bombs: exponential nesting and a use that draws itself", () => {
    let body = '<defs><rect id="l0" width="1" height="1"/>';
    for (let i = 1; i <= 10; i++) {
      body += `<g id="l${i}">${Array.from({ length: 10 }, () => `<use href="#l${i - 1}"/>`).join("")}</g>`;
    }
    refusedWith(svg(`${body}</defs><use href="#l10"/>`), /draws over 50000 elements/);
    refusedWith(svg('<g id="a"><use href="#a"/></g>'), /draws an element that holds it/);
    refusedWith(svg('<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>'), /draws an element that holds it/);
  });
});

/** How long `fn` takes, in milliseconds. */
function elapsed(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("SVG text written to be slow to read", () => {
  test("looksLikeSvg: a declaration, comments and a document type at most before <svg", () => {
    const yes = [
      '<svg viewBox="0 0 1 1"/>',
      '\uFEFF  <?xml version="1.0"?>\n<!-- a --> <!-- b -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<!-- c --><svg>',
      '<!doctype svg [ <!ENTITY a "b"> ] >\n<SVG:svg xmlns:SVG="http://www.w3.org/2000/svg">',
      "<?xml?><svg\n>",
    ];
    const no = [
      '<?xml version="1.0">\n<svg>',
      "<!-- left open <svg>",
      "<!DOCTYPE svg [ <svg>",
      "<svgx>",
      "<html><svg>",
      "text<svg>",
    ];
    for (const text of yes) expect(looksLikeSvg(bytesOf(text))).toBe(true);
    for (const text of no) expect(looksLikeSvg(bytesOf(text))).toBe(false);
  });

  test("comments, document types, CSS comments, url( and lengths left open are read in linear time", () => {
    // Each of these took a regex quadratic (or, for the comments, exponential) time in the text's length.
    expect(elapsed(() => expect(looksLikeSvg(bytesOf(`<!--${"--><!--".repeat(600)}`))).toBe(false))).toBeLessThan(500);
    expect(elapsed(() => refusedWith("<!doctype".repeat(100_000), /over 10000 elements/))).toBeLessThan(1000);
    expect(
      elapsed(() => {
        const out = clean(svg(`<rect width="1" height="1" style="${"/*a".repeat(90_000)}"/>`));
        expect(out.svg).not.toContain("style=");
      }),
    ).toBeLessThan(1000);
    expect(
      elapsed(() => {
        const out = clean(
          svg(`<rect width="1" height="1" style="fill:${"url(".repeat(70_000)}" stroke="${"url(".repeat(70_000)}"/>`),
        );
        expect(out.svg).not.toContain("url(");
        expect(out.removed).toEqual(expect.arrayContaining(["outside references in CSS", "outside references"]));
      }),
    ).toBeLessThan(1000);
    expect(
      elapsed(() => {
        const out = clean(
          svg("<rect/>", `viewBox="0 0 24 12" width="${"1".repeat(200_000)}x" height="1${" ".repeat(200_000)}x"`),
        );
        expect([out.width, out.height]).toEqual([512, 256]);
      }),
    ).toBeLessThan(1000);
  });

  test("a url( left open is an outside reference too: CSS reads it to the end", () => {
    const out = clean(svg('<rect width="1" height="1" style="fill:url(https://example.com/x.png" stroke="url(#ok"/>'));
    expect(out.svg).not.toContain("example.com");
    expect(out.svg).toContain('stroke="url(#ok"');
    expect(out.removed).toContain("outside references in CSS");
  });
});

describe("rasterPicture", () => {
  test("a raster picture as it is; an SVG only through the server's rasterizer, else left out", async () => {
    const png = fakeImagePng("sky");
    expect(await rasterPicture({ bytes: png, contentType: "image/png" })).toEqual({
      bytes: png,
      contentType: "image/png",
    });
    const drawn = sanitizeSvg(svg('<rect width="4" height="4"/>'));
    expect(await rasterPicture({ bytes: drawn.bytes, contentType: SVG_TYPE })).toBeNull();
    setSvgRasterizer(async () => png);
    try {
      expect(await rasterPicture({ bytes: drawn.bytes, contentType: SVG_TYPE })).toEqual({
        bytes: png,
        contentType: "image/png",
      });
      // A rasterizer that answers something else than a PNG is not trusted.
      setSvgRasterizer(async () => new TextEncoder().encode("<html>"));
      expect(await rasterPicture({ bytes: drawn.bytes, contentType: SVG_TYPE })).toBeNull();
    } finally {
      setSvgRasterizer(null);
    }
  });
});
