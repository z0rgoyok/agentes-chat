import { describe, expect, test } from "bun:test";
import { book, type Case, err, ev, put, putAll, same, val } from "./formula-helpers";

// Excel's results over the shared data sheet (`DATA` in the helpers); the formula sits in L1 (row 1, column 12).

const LOGIC: Case[] = [
  ['=IF(A1>5,"big","small")', "big"],
  ["=IF(A1>50,1)", false],
  ["=IF(A1>5,,1)", 0],
  ['=IF("x",1,2)', err("#VALUE!")],
  ["=IF(1/0>1,1,2)", err("#DIV/0!")],
  ["=IF(G3,1,2)", 2],
  ["=IF(TRUE,1/0,2)", err("#DIV/0!")],
  ["=IF(FALSE,1/0,2)", 2],
  ['=IF("TRUE",1,2)', 1],
  ["=SUM(IF(A1:A5>20,A1:A5,0))", 120],
  ["=IFS(A1>50,1,A1>5,2)", 2],
  ["=IFS(A1>50,1)", err("#N/A")],
  ['=IFERROR(1/0,"oops")', "oops"],
  ["=IFERROR(5,0)", 5],
  ["=IFERROR(1/0,)", 0],
  ["=SUM(IFERROR(A1:A3/G1:G3,0))", -5 + 20 / 3.5],
  ["=IFNA(NA(),1)", 1],
  ["=IFNA(1/0,1)", err("#DIV/0!")],
  ["=AND(TRUE,1)", true],
  ["=AND(F1:F3)", false],
  ["=OR(F1:F3)", true],
  ["=OR(FALSE,0)", false],
  ["=XOR(TRUE,TRUE,TRUE)", true],
  ["=XOR(TRUE,TRUE)", false],
  ["=AND(B1:B3)", err("#VALUE!")],
  ['=AND("TRUE",1)', true],
  ['=AND("x")', err("#VALUE!")],
  ["=AND(TRUE,1/0)", err("#DIV/0!")],
  ["=NOT(0)", true],
  ["=NOT(A1)", false],
  ['=SWITCH(2,1,"a",2,"b","c")', "b"],
  ['=SWITCH(9,1,"a",2,"b","c")', "c"],
  ['=SWITCH(9,1,"a")', err("#N/A")],
  ['=SWITCH("B","a",1,"b",2)', 2],
  ["=TRUE()", true],
  ["=FALSE()", false],
];

const INFO: Case[] = [
  ["=ISBLANK(C5)", true],
  ['=ISBLANK("")', false],
  ["=ISNUMBER(A1)", true],
  ["=ISNUMBER(C6)", false],
  ["=ISTEXT(B1)", true],
  ["=ISNONTEXT(A1)", true],
  ["=ISLOGICAL(F1)", true],
  ["=ISERROR(1/0)", true],
  ["=ISERR(NA())", false],
  ["=ISERR(1/0)", true],
  ["=ISNA(NA())", true],
  ["=ISEVEN(4)", true],
  ["=ISEVEN(2.9)", true],
  ["=ISODD(-3)", true],
  ['=ISEVEN("x")', err("#VALUE!")],
  ["=ISREF(A1)", true],
  ["=ISREF(1)", false],
  ["=ISFORMULA(A1)", false],
  ["=SUM(--ISNUMBER(C1:C6))", 2],
  ["=TYPE(1)", 1],
  ['=TYPE("a")', 2],
  ["=TYPE(TRUE)", 4],
  ["=TYPE(1/0)", 16],
  ["=TYPE({1,2})", 64],
  ["=TYPE(A1)", 1],
  ["=TYPE(A1:A2)", 64],
  ["=TYPE(C5)", 1],
  ["=ERROR.TYPE(1/0)", 2],
  ["=ERROR.TYPE(NA())", 7],
  ["=ERROR.TYPE(1)", err("#N/A")],
  ["=NA()", err("#N/A")],
];

const LOOKUP: Case[] = [
  ["=VLOOKUP(30,A1:B5,2,FALSE)", "cherry"],
  ["=VLOOKUP(35,A1:B5,2)", "cherry"],
  ["=VLOOKUP(35,A1:B5,2,TRUE)", "cherry"],
  ["=VLOOKUP(100,A1:B5,2)", "date"],
  ["=VLOOKUP(5,A1:B5,2)", err("#N/A")],
  ["=VLOOKUP(35,A1:B5,2,FALSE)", err("#N/A")],
  ["=VLOOKUP(30,A1:B5,3,FALSE)", err("#REF!")],
  ["=VLOOKUP(30,A1:B5,0,FALSE)", err("#VALUE!")],
  ['=VLOOKUP("CHERRY",B1:C5,1,FALSE)', "cherry"],
  ['=VLOOKUP("ch*",B1:C5,2,FALSE)', true],
  ["=VLOOKUP(30,A1:B5,2,)", "cherry"],
  ['=HLOOKUP(3,{1,2,3;"a","b","c"},2,FALSE)', "c"],
  ['=HLOOKUP(2.5,{1,2,3;"a","b","c"},2)', "b"],
  ["=LOOKUP(35,A1:A5,B1:B5)", "cherry"],
  ["=LOOKUP(35,A1:B5)", "cherry"],
  ["=LOOKUP(1,A1:A5)", err("#N/A")],
  ["=MATCH(30,A1:A5,0)", 3],
  ["=MATCH(35,A1:A5)", 3],
  ['=MATCH("b*",B1:B5,0)', 2],
  ["=MATCH(25,{50,40,30,20,10},-1)", 3],
  ["=MATCH(99,A1:A5,0)", err("#N/A")],
  ["=MATCH(1,A1:B5,0)", err("#N/A")],
  ["=XMATCH(30,A1:A5)", 3],
  ["=XMATCH(35,A1:A5,1)", 4],
  ["=XMATCH(35,A1:A5,-1)", 3],
  ['=XMATCH("*pie",B1:B5,2)', 4],
  ["=XMATCH(20,{10,20,20,30},0,-1)", 3],
  ["=XMATCH(40,A1:A5,0,2)", 4],
  ["=XLOOKUP(30,A1:A5,B1:B5)", "cherry"],
  ['=XLOOKUP(35,A1:A5,B1:B5,"none")', "none"],
  ["=XLOOKUP(35,A1:A5,B1:B5)", err("#N/A")],
  ["=XLOOKUP(35,A1:A5,B1:B5,,1)", "apple pie"],
  ["=XLOOKUP(35,A1:A5,B1:B5,,-1)", "cherry"],
  ['=XLOOKUP("date",B1:B5,A1:A5)', 50],
  ["=SUM(XLOOKUP(20,A1:A5,A1:C5))", 20],
  ['=XLOOKUP(2,{1,2,3},{"a","b","c"})', "b"],
  ["=XLOOKUP(30,A1:A5,B1:B4)", err("#VALUE!")],
  ["=INDEX(A1:B5,3,2)", "cherry"],
  ["=INDEX(A1:A5,4)", 40],
  ["=INDEX({1,2,3},2)", 2],
  ["=SUM(INDEX(A1:B5,0,1))", 150],
  ["=SUM(INDEX(A1:B5,2,0))", 20],
  ["=INDEX(A1:A5,6)", err("#REF!")],
  ["=SUM(A1:INDEX(A1:A5,3))", 60],
  ['=CHOOSE(2,"a","b","c")', "b"],
  ['=CHOOSE(4,"a","b","c")', err("#VALUE!")],
  ["=SUM(CHOOSE(2,A1:A2,A3:A4))", 70],
  ["=CHOOSE(2,1/0,5)", 5],
  ["=SUM(CHOOSE({1,2},10,20))", 30],
  ["=ROW()", 1],
  ["=ROW(A7)", 7],
  ["=COLUMN()", 12],
  ["=COLUMN(C1)", 3],
  ["=SUM(ROW(A1:A3))", 6],
  ["=ROWS(A1:B5)", 5],
  ["=COLUMNS(A1:B5)", 2],
  ["=ROWS({1;2;3})", 3],
  ["=SUM(OFFSET(A1,1,0,2,1))", 50],
  ["=OFFSET(A1,2,1)", "cherry"],
  ["=OFFSET(A1,-1,0)", err("#REF!")],
  ["=SUM(OFFSET(A1:A2,1,0))", 50],
  ["=OFFSET(A1,0,0,0)", err("#REF!")],
  ["=OFFSET(A1,100,0)", 0],
  ['=INDIRECT("A2")', 20],
  ['=INDIRECT("Other!A2")', 200],
  ["=INDIRECT(\"'Other'!A1\")", 100],
  ['=SUM(INDIRECT("A1:A3"))', 60],
  ['=INDIRECT("Nope!A1")', err("#REF!")],
  ['=INDIRECT("R2C1",FALSE)', 20],
  ['=INDIRECT("R[1]C[-11]",FALSE)', 20],
  ['=INDIRECT("hello")', err("#REF!")],
  ['=SUM(INDIRECT("A:A"))', 150],
  ['=INDIRECT("B"&2)', "Banana"],
  ["=SUM(TRANSPOSE(A1:A3))", 60],
  ["=INDEX(TRANSPOSE(A1:B2),2,1)", "apple"],
  ["=ROWS(UNIQUE({1;2;2;3;1}))", 3],
  ['=INDEX(UNIQUE({"a";"A";"b"}),2)', "b"],
  ["=ROWS(UNIQUE({1;2;2;3;1},,TRUE))", 1],
  ["=UNIQUE({1;1},,TRUE)", err("#CALC!")],
  ["=COLUMNS(UNIQUE({1,1,2},TRUE))", 2],
  ["=INDEX(SORT({3;1;2}),1)", 1],
  ["=INDEX(SORT({3;1;2},1,-1),1)", 3],
  ["=INDEX(SORT(B1:B5),1)", "apple"],
  ["=INDEX(SORT(B1:B5),3)", "Banana"],
  ["=INDEX(SORT(A1:B5,2,1),1,2)", "apple"],
  ["=INDEX(SORT(A1:B5,2,-1),1,1)", 50],
  ["=SORT({1,2},3)", err("#VALUE!")],
  ['=INDEX(SORT({"b";2;TRUE;"a";1}),3)', "a"],
  ["=SUM(FILTER(A1:A5,A1:A5>25))", 120],
  ["=FILTER(A1:A5,A1:A5>100)", err("#CALC!")],
  ['=FILTER(A1:A5,A1:A5>100,"none")', "none"],
  ['=INDEX(FILTER(A1:B5,B1:B5="date"),1,1)', 50],
  ["=FILTER(A1:A5,{1;0})", err("#VALUE!")],
  ["=SUM(SEQUENCE(10))", 55],
  ["=SEQUENCE(3,,5)", 5],
  ["=INDEX(SEQUENCE(2,3,0,10),2,3)", 50],
  ["=SEQUENCE(0)", err("#CALC!")],
];

describe("logic", () => {
  test.each(LOGIC)("%s", (formula, expected) => same(ev(formula), expected));
});

describe("information", () => {
  test.each(INFO)("%s", (formula, expected) => same(ev(formula), expected));

  test("ISFORMULA sees formulas", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 4 });
    putAll(b, { A1: 1, A2: "=A1+1", B1: "=ISFORMULA(A2)", B2: "=ISFORMULA(A1)" });
    expect(val(b, "B1")).toBe(true);
    expect(val(b, "B2")).toBe(false);
    put(b, "A2", 5);
    expect(val(b, "B1")).toBe(false);
  });
});

describe("lookup and arrays", () => {
  test.each(LOOKUP)("%s", (formula, expected) => same(ev(formula), expected));

  test("an array result shows its top-left value", () => {
    expect(ev("=A1:A5*2")).toBe(20);
    expect(ev("={7,8;9,10}")).toBe(7);
    expect(ev("=A1:B2")).toBe(10);
    expect(ev("=C5")).toBe(0);
    expect(ev("=SORT(A1:A5,1,-1)")).toBe(50);
  });

  test("approximate lookups skip empty cells", () => {
    const b = book(["Sheet1"], { rows: 10, cols: 4 });
    putAll(b, { A1: 1, A2: 2, A4: 4, A5: 5, B1: "=MATCH(3,A1:A5)", B2: "=VLOOKUP(4.5,A1:A5,1)" });
    expect(val(b, "B1")).toBe(2);
    expect(val(b, "B2")).toBe(4);
  });
});
