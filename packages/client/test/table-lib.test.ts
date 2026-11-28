import { describe, expect, test } from "bun:test";
import {
  linkSite,
  TABLE_PREVIEW_ROWS,
  tableCellRead,
  tableColumnKinds,
  tablePreviewed,
  tableTsv,
} from "../src/lib/table";

const rows = (...cells: string[][]) => cells.map((r) => r.map(tableCellRead));

describe("a table's columns by what they hold", () => {
  test("a count, a long name, a link, a number with its unit and a short word", () => {
    const table = rows(
      ["1", "Tecelagem Aurora Indústria Têxtil Ltda.", "https://www.aurora.example/", "21 dias", "Respondeu"],
      [
        "2",
        "Fios do Vale Comércio e Representações S.A.",
        "[Fios do Vale](https://fios.example)",
        "R$ 16,90",
        "Aguardando",
      ],
      ["3", "Malharia Horizonte", "<https://horizonte.example>", "1.000 m", "Recusou"],
    );
    expect(tableColumnKinds(table, 5)).toEqual(["index", "text", "link", "number", "short"]);
  });

  test("numbers only count the rows in the first column; elsewhere they are numbers", () => {
    expect(tableColumnKinds(rows(["a", "1"], ["b", "2"]), 2)).toEqual(["short", "number"]);
  });

  test("a column of links with a word or two among them is still a column of links; an empty one is short", () => {
    const table = rows(["https://a.example", ""], ["—", ""], ["https://b.example", ""]);
    expect(tableColumnKinds(table, 2)).toEqual(["link", "short"]);
  });

  test("a cell is only a link when nothing else is in it", () => {
    expect(tableCellRead(" [Site](https://a.example) ")).toEqual({ text: "Site", link: true });
    expect(tableCellRead("see https://a.example")).toEqual({ text: "see https://a.example", link: false });
    expect(tableCellRead("**Aurora**")).toEqual({ text: "Aurora", link: false });
  });
});

describe("a link's site", () => {
  test("the host without www, the path or the scheme; null for anything but a web address", () => {
    expect(linkSite("https://www.tecelagemaurora.com.br/contato?x=1")).toBe("tecelagemaurora.com.br");
    expect(linkSite("http://Shop.Example.com")).toBe("shop.example.com");
    expect(linkSite("mailto:ana@example.com")).toBeNull();
    expect(linkSite("not a link")).toBeNull();
  });
});

describe("a table copied", () => {
  test("cells split by tabs, rows by lines, a tab or a break inside a cell turned into a space", () => {
    expect(
      tableTsv(["Name", "Site"], [["Aurora\tLtda.", "a.example"], ["Vale", "b.example\nhome"], ["Horizonte"]]),
    ).toBe("Name\tSite\nAurora Ltda.\ta.example\nVale\tb.example home\nHorizonte\t");
  });

  test("a long table shows its first rows only when more than two are left out", () => {
    expect(tablePreviewed(TABLE_PREVIEW_ROWS + 2)).toBe(false);
    expect(tablePreviewed(TABLE_PREVIEW_ROWS + 3)).toBe(true);
  });
});
