import { describe, expect, test } from "bun:test";
import type { CellError } from "../src/spreadsheet/values";
import { book, type Case, err, ev, PT, put, putAll, same, val } from "./formula-helpers";

// Excel's results over the shared data sheet (`DATA` in the helpers). E1 is 2026-11-17 (serial 46343, a Tuesday),
// E2 the 18th, E3 the 24th.

const TEXT: Case[] = [
  ['=CONCAT("a",1,TRUE)', "a1TRUE"],
  ["=CONCAT(A1:A3)", "102030"],
  ['=CONCATENATE("a","b")', "ab"],
  ['=A1&" kg"', "10 kg"],
  ['=1.5&""', "1.5"],
  ['=1/3&""', "0.333333333333333"],
  ['=TRUE&""', "TRUE"],
  ['=1E+20&""', "1E+20"],
  ['=123456789012345678&""', "1.23456789012346E+17"],
  ['=TEXTJOIN(", ",TRUE,B1:B3)', "apple, Banana, cherry"],
  ['=TEXTJOIN("-",TRUE,"a","","b")', "a-b"],
  ['=TEXTJOIN("-",FALSE,"a","","b")', "a--b"],
  ['=TEXTJOIN({"-","+"},TRUE,"a","b","c")', "a-b+c"],
  ['=LEFT("hello",2)', "he"],
  ['=LEFT("hello")', "h"],
  ['=RIGHT("hello",3)', "llo"],
  ['=MID("hello",2,3)', "ell"],
  ['=MID("hello",9,2)', ""],
  ['=MID("hello",0,2)', err("#VALUE!")],
  ['=LEFT("hi",-1)', err("#VALUE!")],
  ["=LEFT(12345,2)", "12"],
  ['=LEN("hello")', 5],
  ["=LEN(A1)", 2],
  ["=LEN(C5)", 0],
  ["=SUM(LEN(B1:B2))", 11],
  ['=UPPER("aÇão")', "AÇÃO"],
  ['=LOWER("ABC")', "abc"],
  ['=PROPER("hello wORLD 2nd")', "Hello World 2Nd"],
  ['=TRIM("  a   b  ")', "a b"],
  ['=CLEAN("a"&CHAR(9)&"b")', "ab"],
  ['=SUBSTITUTE("a-b-c","-","+")', "a+b+c"],
  ['=SUBSTITUTE("a-b-c","-","+",2)', "a-b+c"],
  ['=SUBSTITUTE("aaa","a","b",3)', "aab"],
  ['=SUBSTITUTE("abc","","x")', "abc"],
  ['=SUBSTITUTE("abc","b","x",0)', err("#VALUE!")],
  ['=REPLACE("abcdef",2,3,"X")', "aXef"],
  ['=REPLACE("abc",5,1,"Z")', "abcZ"],
  ['=FIND("b","abcb")', 2],
  ['=FIND("b","abcb",3)', 4],
  ['=FIND("B","abc")', err("#VALUE!")],
  ['=FIND("","abc")', 1],
  ['=SEARCH("B","abc")', 2],
  ['=SEARCH("c?e","abcdef")', 3],
  ['=SEARCH("*c","abc")', 1],
  ['=SEARCH("~*","a*b")', 2],
  ['=SEARCH("z","abc")', err("#VALUE!")],
  ['=TEXT(1234.567,"#,##0.00")', "1,234.57"],
  ['=TEXT(0.256,"0.0%")', "25.6%"],
  ['=TEXT(46343,"yyyy-mm-dd")', "2026-11-17"],
  ['=TEXT(E1,"dddd")', "Tuesday"],
  ['=TEXT("12","0.0")', "12.0"],
  ['=TEXT(-5,"0;(0)")', "(5)"],
  ['=TEXT(1,"")', ""],
  ['=VALUE("1,234.5")', 1234.5],
  ['=VALUE("50%")', 0.5],
  ['=VALUE("$10")', 10],
  ['=VALUE("abc")', err("#VALUE!")],
  ['=VALUE("2026-11-17")', 46343],
  ['=VALUE("12:00")', 0.5],
  ["=VALUE(TRUE)", err("#VALUE!")],
  ['=NUMBERVALUE("1.234,5",",",".")', 1234.5],
  ['=NUMBERVALUE("12%")', 0.12],
  ['=NUMBERVALUE("1.2.3",".")', err("#VALUE!")],
  ['=REPT("ab",3)', "ababab"],
  ['=REPT("a",-1)', err("#VALUE!")],
  ['=EXACT("a","A")', false],
  ['=EXACT("a","a")', true],
  ["=CHAR(65)", "A"],
  ["=CHAR(128)", "€"],
  ["=CHAR(0)", err("#VALUE!")],
  ['=CODE("A")', 65],
  ['=CODE("€")', 128],
  ['=CODE("")', err("#VALUE!")],
  ["=UNICHAR(9731)", "☃"],
  ['=UNICODE("☃")', 9731],
  ['=T("a")', "a"],
  ["=T(1)", ""],
  ["=N(TRUE)", 1],
  ['=N("a")', 0],
  ["=N(A2)", 20],
  ['=TEXTBEFORE("a-b-c","-")', "a"],
  ['=TEXTBEFORE("a-b-c","-",2)', "a-b"],
  ['=TEXTBEFORE("a-b-c","-",-1)', "a-b"],
  ['=TEXTAFTER("a-b-c","-")', "b-c"],
  ['=TEXTAFTER("a-b-c","-",-1)', "c"],
  ['=TEXTBEFORE("abc","x")', err("#N/A")],
  ['=TEXTBEFORE("abc","x",,,,"none")', "none"],
  ['=TEXTAFTER("aXbxc","x",1,1)', "bxc"],
  ['=TEXTBEFORE("abc","x",1,0,1)', "abc"],
  ['=TEXTBEFORE("abc",{"b","c"})', "a"],
  ["=FIXED(1234.567,1)", "1,234.6"],
  ["=FIXED(1234.567,1,TRUE)", "1234.6"],
  ["=FIXED(1234.567,-1)", "1,230"],
  ["=FIXED(-0.5)", "-0.50"],
];

const DATES: Case[] = [
  ["=DATE(2026,11,17)", 46343],
  ["=DATE(2000,1,1)", 36526],
  ["=DATE(2026,13,1)", 46388],
  ["=DATE(2026,1,0)", 46022],
  ["=DATE(1900,2,29)", 60],
  ["=DATE(1900,3,1)", 61],
  ["=DATE(1900,3,0)", 60],
  ["=DATE(1900,1,1)", 1],
  ["=DATE(100,1,1)", 36526],
  ["=DATE(-1,1,1)", err("#NUM!")],
  ["=DATE(10000,1,1)", err("#NUM!")],
  ["=YEAR(E1)", 2026],
  ["=MONTH(E1)", 11],
  ["=DAY(E1)", 17],
  ["=YEAR(60)", 1900],
  ["=MONTH(60)", 2],
  ["=DAY(60)", 29],
  ["=DAY(0)", 0],
  ['=YEAR("2026-11-17")', 2026],
  ["=YEAR(-1)", err("#NUM!")],
  ["=TIME(12,30,0)", 0.5208333333333334],
  ["=TIME(25,0,0)", 1 / 24],
  ["=TIME(0,-1,0)", err("#NUM!")],
  ["=HOUR(0.75)", 18],
  ["=MINUTE(TIME(10,45,30))", 45],
  ["=SECOND(TIME(10,45,30))", 30],
  ['=HOUR("13:45")', 13],
  ["=WEEKDAY(E1)", 3],
  ["=WEEKDAY(E1,2)", 2],
  ["=WEEKDAY(E1,3)", 1],
  ["=WEEKDAY(E1,11)", 2],
  ["=WEEKDAY(E1,12)", 1],
  ["=WEEKDAY(E1,16)", 4],
  ["=WEEKDAY(E1,17)", 3],
  ["=WEEKDAY(E1,4)", err("#NUM!")],
  ["=WEEKDAY(1)", 1],
  ["=WEEKNUM(E1)", 47],
  ["=WEEKNUM(E1,2)", 47],
  ["=WEEKNUM(DATE(2026,1,3))", 1],
  ["=WEEKNUM(DATE(2026,1,4))", 2],
  ["=WEEKNUM(DATE(2026,1,4),21)", 1],
  ["=ISOWEEKNUM(E1)", 47],
  ["=ISOWEEKNUM(DATE(2021,1,1))", 53],
  ["=EDATE(DATE(2026,1,31),1)", 46081],
  ["=EDATE(E1,-12)", 45978],
  ["=EOMONTH(E1,0)", 46356],
  ["=EOMONTH(E1,3)", 46446],
  ["=EOMONTH(DATE(1900,1,15),1)", 60],
  ['=DATEDIF(DATE(2020,2,29),E1,"Y")', 6],
  ['=DATEDIF(DATE(2020,2,29),E1,"M")', 80],
  ['=DATEDIF(DATE(2020,2,29),E1,"D")', 2453],
  ['=DATEDIF(DATE(2020,2,29),E1,"YM")', 8],
  ['=DATEDIF(DATE(2020,2,29),E1,"MD")', 19],
  ['=DATEDIF(DATE(2025,3,10),E1,"YD")', 252],
  ['=DATEDIF(E2,E1,"D")', err("#NUM!")],
  ['=DATEDIF(E1,E2,"W")', err("#NUM!")],
  ["=DAYS(E3,E1)", 7],
  ['=DAYS("2026-11-24","2026-11-17")', 7],
  ["=DAYS360(DATE(2026,1,30),DATE(2026,2,28))", 28],
  ["=DAYS360(DATE(2026,1,31),DATE(2026,3,31))", 60],
  ["=DAYS360(DATE(2026,1,31),DATE(2026,3,31),TRUE)", 60],
  ["=NETWORKDAYS(E1,E3)", 6],
  ["=NETWORKDAYS(E1,E3,E2)", 5],
  ["=NETWORKDAYS(E3,E1)", -6],
  ["=NETWORKDAYS.INTL(E1,E3,11)", 7],
  ['=NETWORKDAYS.INTL(E1,E3,"0000011")', 6],
  ['=NETWORKDAYS.INTL(E1,E3,"1111111")', err("#VALUE!")],
  ["=WORKDAY(E1,5)", 46350],
  ["=WORKDAY(E1,5,E2)", 46351],
  ["=WORKDAY(E1,-2)", 46339],
  ["=WORKDAY(E1,0)", 46343],
  ["=WORKDAY.INTL(E1,1,7)", 46344],
  ['=DATEVALUE("2026-11-17")', 46343],
  ['=DATEVALUE("11/17/2026")', 46343],
  ['=DATEVALUE("17 Nov 2026")', 46343],
  ['=DATEVALUE("2026-11-17 18:00")', 46343],
  ['=DATEVALUE("nope")', err("#VALUE!")],
  ["=DATEVALUE(46343)", err("#VALUE!")],
  ['=TIMEVALUE("18:00")', 0.75],
  ['=TIMEVALUE("2026-11-17 06:00")', 0.25],
  ['=TIMEVALUE("6:00 PM")', 0.75],
  ["=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1))", 0.5],
  ["=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1),1)", 181 / 365],
  ["=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1),2)", 181 / 360],
  ["=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1),3)", 181 / 365],
  ["=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1),4)", 0.5],
  ["=YEARFRAC(DATE(2024,1,1),DATE(2024,12,31),1)", 365 / 366],
  ["=YEARFRAC(DATE(2026,1,1),DATE(2026,7,1),5)", err("#NUM!")],
  ["=E3-E1", 7],
  ["=E1+1", 46344],
];

/** Excel's documented results, to the digits its documentation gives (`tolerance`), or its errors. */
const FINANCE: [string, number | CellError, number][] = [
  ["=PMT(0.08/12,10,10000)", -1037.03, 0.005],
  ["=PMT(0.06/12,18*12,0,50000)", -129.08, 0.005],
  ["=PMT(0,10,1000)", -100, 1e-9],
  ["=PMT(0.1,0,1000)", err("#NUM!"), 0],
  ["=FV(0.06/12,10,-200,-500,1)", 2581.4, 0.005],
  ["=FV(0,10,-100)", 1000, 1e-9],
  ["=PV(0.08/12,12*20,500,,0)", -59777.15, 0.005],
  ["=NPV(0.1,-10000,3000,4200,6800)", 1188.44, 0.005],
  ["=NPV(-1,1)", err("#DIV/0!"), 0],
  ["=IRR({-70000,12000,15000,18000,21000,26000})", 0.086630948, 1e-8],
  ["=IRR({-70000,12000,15000,18000,21000})", -0.021244848, 1e-8],
  ["=IRR({-70000,12000,15000,18000,21000,26000},-0.5)", 0.086630948, 1e-8],
  ["=IRR({1,2})", err("#NUM!"), 0],
  // Amounts in the billions settle as precisely as small ones (the roots here were checked by plain bisection).
  ["=IRR({-1000000000,300000000,400000000,500000000})", 0.088963394693, 1e-10],
  ["=IRR({-123456789012,10000000000,20000000000,30000000000,40000000000,50000000000})", 0.055202108036, 1e-10],
  ["=RATE(360,-1000000,150000000)", 0.005850253377, 1e-11],
  ["=RATE(4*12,-200,8000)", 0.007701472, 1e-8],
  ["=RATE(10,-100,1000)", 0, 1e-9],
  ["=NPER(0.12/12,-100,-1000,10000,1)", 59.6738657, 1e-6],
  ["=NPER(0,-100,1000)", 10, 1e-9],
  ["=IPMT(0.1/12,1,3*12,8000)", -66.67, 0.005],
  ["=IPMT(0.1/12,0,3*12,8000)", err("#NUM!"), 0],
  ["=PPMT(0.1/12,1,2*12,2000)", -75.62, 0.005],
  ["=CUMIPMT(0.09/12,30*12,125000,13,24,0)", -11135.23213, 1e-5],
  ["=CUMPRINC(0.09/12,30*12,125000,13,24,0)", -934.1071234, 1e-6],
  ["=EFFECT(0.0525,4)", 0.05354267, 1e-8],
  ["=NOMINAL(0.053543,4)", 0.05250032, 1e-8],
  ["=SLN(30000,7500,10)", 2250, 1e-9],
  ["=XNPV(0.09,{-10000,2750,4250,3250,2750},{39448,39508,39751,39859,39904})", 2086.65, 0.005],
  ["=XIRR({-10000,2750,4250,3250,2750},{39448,39508,39751,39859,39904})", 0.373362535, 1e-8],
];

describe("text", () => {
  test.each(TEXT)("%s", (formula, expected) => same(ev(formula), expected));

  test("a Portuguese document computes text the Brazilian way", () => {
    const b = book(["Planilha 1"], { rows: 6, cols: 4, locale: "pt-BR" });
    put(b, "A1", 1234.5);
    put(b, "B1", '=TEXTO(A1;"#.##0,00")', { locale: PT });
    put(b, "B2", '=A1&" reais"', { locale: PT });
    put(b, "B3", '=VALOR("1.234,5")', { locale: PT });
    put(b, "B4", '=TEXTO(46343;"dd/mm/aaaa")', { locale: PT });
    put(b, "B5", '=TEXTO(46343;"dddd")', { locale: PT });
    put(b, "C1", '=VERDADEIRO&""', { locale: PT });
    put(b, "C2", "=DEF.NÚM.DEC(1234,567;1)", { locale: PT });
    put(b, "C3", '=VALOR("1,5")*2', { locale: PT });
    expect(val(b, "B1")).toBe("1.234,50");
    expect(val(b, "B2")).toBe("1234,5 reais");
    expect(val(b, "B3")).toBe(1234.5);
    expect(val(b, "B4")).toBe("17/11/2026");
    expect(val(b, "B5")).toBe("terça-feira");
    expect(val(b, "C1")).toBe("VERDADEIRO");
    expect(val(b, "C2")).toBe("1.234,6");
    expect(val(b, "C3")).toBe(3);
  });
});

describe("dates and times", () => {
  test.each(DATES)("%s", (formula, expected) => same(ev(formula), expected));

  test("TODAY and NOW read the engine's clock", () => {
    let now = new Date(2026, 10, 17, 9, 30, 0);
    const b = book(["Sheet1"], { rows: 5, cols: 3, now: () => now });
    putAll(b, { A1: "=TODAY()", A2: "=NOW()", A3: "=A1+1" });
    expect(val(b, "A1")).toBe(46343);
    same(val(b, "A2"), 46343 + 9.5 / 24);
    expect(val(b, "A3")).toBe(46344);
    now = new Date(2026, 10, 18, 0, 5, 0);
    expect(val(b, "A1")).toBe(46343);
    b.engine.tick();
    expect(val(b, "A1")).toBe(46344);
    expect(val(b, "A3")).toBe(46345);
  });
});

describe("finance", () => {
  test.each(FINANCE)("%s", (formula, expected, tolerance) => {
    const actual = ev(formula);
    if (typeof expected === "number") {
      expect(typeof actual).toBe("number");
      expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);
    } else expect(actual).toEqual(expected);
  });
});
