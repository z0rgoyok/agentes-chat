/**
 * Excel's Brazilian Portuguese function names (ADR 0196 §2): formulas are typed and shown with them in Portuguese
 * (`=SOMA(B2:B9;C2)`) and stored with the English ones. Typing in Portuguese also accepts the English names, a few
 * names other spreadsheet apps use, and every name without its accents (`MEDIA`, `MAXIMO`), since many keyboards
 * make accents slow to type.
 */

/** Canonical (English) name → Excel's Brazilian name. */
export const PT_NAMES: Readonly<Record<string, string>> = {
  // Math
  ABS: "ABS",
  ACOS: "ACOS",
  ACOSH: "ACOSH",
  ASIN: "ASEN",
  ASINH: "ASENH",
  ATAN: "ATAN",
  ATAN2: "ATAN2",
  ATANH: "ATANH",
  CEILING: "TETO",
  "CEILING.MATH": "TETO.MAT",
  "CEILING.PRECISE": "TETO.PRECISO",
  COMBIN: "COMBIN",
  COS: "COS",
  COSH: "COSH",
  DEGREES: "GRAUS",
  EVEN: "PAR",
  EXP: "EXP",
  FACT: "FATORIAL",
  FLOOR: "ARREDMULTB",
  "FLOOR.MATH": "ARREDMULTB.MAT",
  "FLOOR.PRECISE": "ARREDMULTB.PRECISO",
  GCD: "MDC",
  INT: "INT",
  LCM: "MMC",
  LN: "LN",
  LOG: "LOG",
  LOG10: "LOG10",
  MOD: "MOD",
  MROUND: "MARRED",
  ODD: "ÍMPAR",
  PI: "PI",
  POWER: "POTÊNCIA",
  PRODUCT: "MULT",
  QUOTIENT: "QUOCIENTE",
  RADIANS: "RADIANOS",
  RAND: "ALEATÓRIO",
  RANDBETWEEN: "ALEATÓRIOENTRE",
  ROUND: "ARRED",
  ROUNDDOWN: "ARREDONDAR.PARA.BAIXO",
  ROUNDUP: "ARREDONDAR.PARA.CIMA",
  SIGN: "SINAL",
  SIN: "SEN",
  SINH: "SENH",
  SQRT: "RAIZ",
  SQRTPI: "RAIZPI",
  SUBTOTAL: "SUBTOTAL",
  SUM: "SOMA",
  SUMIF: "SOMASE",
  SUMIFS: "SOMASES",
  SUMPRODUCT: "SOMARPRODUTO",
  SUMSQ: "SOMAQUAD",
  TAN: "TAN",
  TANH: "TANH",
  TRUNC: "TRUNCAR",
  // Statistics
  AVEDEV: "DESV.MÉDIO",
  AVERAGE: "MÉDIA",
  AVERAGEA: "MÉDIAA",
  AVERAGEIF: "MÉDIASE",
  AVERAGEIFS: "MÉDIASES",
  CORREL: "CORREL",
  COUNT: "CONT.NÚM",
  COUNTA: "CONT.VALORES",
  COUNTBLANK: "CONTAR.VAZIO",
  COUNTIF: "CONT.SE",
  COUNTIFS: "CONT.SES",
  "COVARIANCE.P": "COVARIAÇÃO.P",
  "COVARIANCE.S": "COVARIAÇÃO.S",
  DEVSQ: "DESVQ",
  FORECAST: "PREVISÃO",
  "FORECAST.LINEAR": "PREVISÃO.LINEAR",
  GEOMEAN: "MÉDIA.GEOMÉTRICA",
  HARMEAN: "MÉDIA.HARMÔNICA",
  INTERCEPT: "INTERCEPÇÃO",
  LARGE: "MAIOR",
  MAX: "MÁXIMO",
  MAXA: "MÁXIMOA",
  MAXIFS: "MÁXIMOSES",
  MEDIAN: "MED",
  MIN: "MÍNIMO",
  MINA: "MÍNIMOA",
  MINIFS: "MÍNIMOSES",
  MODE: "MODO",
  "MODE.SNGL": "MODO.ÚNICO",
  PEARSON: "PEARSON",
  PERCENTILE: "PERCENTIL",
  "PERCENTILE.EXC": "PERCENTIL.EXC",
  "PERCENTILE.INC": "PERCENTIL.INC",
  PERCENTRANK: "ORDEM.PORCENTUAL",
  "PERCENTRANK.INC": "ORDEM.PORCENTUAL.INC",
  QUARTILE: "QUARTIL",
  "QUARTILE.EXC": "QUARTIL.EXC",
  "QUARTILE.INC": "QUARTIL.INC",
  RANK: "ORDEM",
  "RANK.AVG": "ORDEM.MÉD",
  "RANK.EQ": "ORDEM.EQ",
  RSQ: "RQUAD",
  SLOPE: "INCLINAÇÃO",
  SMALL: "MENOR",
  STANDARDIZE: "PADRONIZAR",
  STDEV: "DESVPAD",
  "STDEV.P": "DESVPAD.P",
  "STDEV.S": "DESVPAD.A",
  STDEVA: "DESVPADA",
  STDEVP: "DESVPADP",
  TRIMMEAN: "MÉDIA.INTERNA",
  VAR: "VAR",
  "VAR.P": "VAR.P",
  "VAR.S": "VAR.A",
  VARA: "VARA",
  VARP: "VARP",
  // Logic
  AND: "E",
  FALSE: "FALSO",
  IF: "SE",
  IFERROR: "SEERRO",
  IFNA: "SENÃODISP",
  IFS: "SES",
  NOT: "NÃO",
  OR: "OU",
  SWITCH: "PARÂMETRO",
  TRUE: "VERDADEIRO",
  XOR: "OUEXCL",
  // Lookup and arrays
  CHOOSE: "ESCOLHER",
  COLUMN: "COL",
  COLUMNS: "COLS",
  FILTER: "FILTRAR",
  HLOOKUP: "PROCH",
  INDEX: "ÍNDICE",
  INDIRECT: "INDIRETO",
  LOOKUP: "PROC",
  MATCH: "CORRESP",
  OFFSET: "DESLOC",
  ROW: "LIN",
  ROWS: "LINS",
  SEQUENCE: "SEQUÊNCIA",
  SORT: "CLASSIFICAR",
  TRANSPOSE: "TRANSPOR",
  UNIQUE: "ÚNICO",
  VLOOKUP: "PROCV",
  XLOOKUP: "PROCX",
  XMATCH: "CORRESPX",
  // Text
  CHAR: "CARACT",
  CLEAN: "TIRAR",
  CODE: "CÓDIGO",
  CONCAT: "CONCAT",
  CONCATENATE: "CONCATENAR",
  DOLLAR: "MOEDA",
  EXACT: "EXATO",
  FIND: "PROCURAR",
  FIXED: "DEF.NÚM.DEC",
  LEFT: "ESQUERDA",
  LEN: "NÚM.CARACT",
  LOWER: "MINÚSCULA",
  MID: "EXT.TEXTO",
  NUMBERVALUE: "VALORNUMÉRICO",
  PROPER: "PRI.MAIÚSCULA",
  REPLACE: "MUDAR",
  REPT: "REPT",
  RIGHT: "DIREITA",
  SEARCH: "LOCALIZAR",
  SUBSTITUTE: "SUBSTITUIR",
  T: "T",
  TEXT: "TEXTO",
  TEXTAFTER: "TEXTODEPOIS",
  TEXTBEFORE: "TEXTOANTES",
  TEXTJOIN: "UNIRTEXTO",
  TRIM: "ARRUMAR",
  UNICHAR: "CARACTUNICODE",
  UNICODE: "UNICODE",
  UPPER: "MAIÚSCULA",
  VALUE: "VALOR",
  // Dates and times
  DATE: "DATA",
  DATEDIF: "DATADIF",
  DATEVALUE: "DATA.VALOR",
  DAY: "DIA",
  DAYS: "DIAS",
  DAYS360: "DIAS360",
  EDATE: "DATAM",
  EOMONTH: "FIMMÊS",
  HOUR: "HORA",
  ISOWEEKNUM: "NÚMSEMANAISO",
  MINUTE: "MINUTO",
  MONTH: "MÊS",
  NETWORKDAYS: "DIATRABALHOTOTAL",
  "NETWORKDAYS.INTL": "DIATRABALHOTOTAL.INTL",
  NOW: "AGORA",
  SECOND: "SEGUNDO",
  TIME: "TEMPO",
  TIMEVALUE: "VALOR.TEMPO",
  TODAY: "HOJE",
  WEEKDAY: "DIA.DA.SEMANA",
  WEEKNUM: "NÚMSEMANA",
  WORKDAY: "DIATRABALHO",
  "WORKDAY.INTL": "DIATRABALHO.INTL",
  YEAR: "ANO",
  YEARFRAC: "FRAÇÃOANO",
  // Information
  "ERROR.TYPE": "TIPO.ERRO",
  ISBLANK: "ÉCÉL.VAZIA",
  ISERR: "ÉERRO",
  ISERROR: "ÉERROS",
  ISEVEN: "ÉPAR",
  ISFORMULA: "ÉFÓRMULA",
  ISLOGICAL: "ÉLÓGICO",
  ISNA: "É.NÃO.DISP",
  ISNONTEXT: "É.NÃO.TEXTO",
  ISNUMBER: "ÉNÚM",
  ISODD: "ÉIMPAR",
  ISREF: "ÉREF",
  ISTEXT: "ÉTEXTO",
  N: "N",
  NA: "NÃO.DISP",
  TYPE: "TIPO",
  // Finance
  CUMIPMT: "PGTOJURACUM",
  CUMPRINC: "PGTOCAPACUM",
  EFFECT: "EFETIVA",
  FV: "VF",
  IPMT: "IPGTO",
  IRR: "TIR",
  NOMINAL: "NOMINAL",
  NPER: "NPER",
  NPV: "VPL",
  PMT: "PGTO",
  PPMT: "PPGTO",
  PV: "VP",
  RATE: "TAXA",
  SLN: "DPD",
  XIRR: "XTIR",
  XNPV: "XVPL",
};

/**
 * Other Portuguese names accepted when typing: what other spreadsheet apps and older Excel versions call some
 * functions, and short forms people write.
 */
export const PT_ALTERNATES: Readonly<Record<string, string>> = {
  MÍN: "MIN",
  MÁX: "MAX",
  CORRESPONDER: "MATCH",
  LINHA: "ROW",
  LINHAS: "ROWS",
  COLUNA: "COLUMN",
  COLUNAS: "COLUMNS",
  HORÁRIO: "TIME",
  FATO: "FACT",
  ÉNÚMERO: "ISNUMBER",
  PRODUTO: "PRODUCT",
  CLASSIFICAÇÃO: "RANK",
  LIMPAR: "CLEAN",
};

const ACCENTS: Readonly<Record<string, string>> = {
  Á: "A",
  À: "A",
  Â: "A",
  Ã: "A",
  Ä: "A",
  É: "E",
  È: "E",
  Ê: "E",
  Ë: "E",
  Í: "I",
  Ì: "I",
  Î: "I",
  Ï: "I",
  Ó: "O",
  Ò: "O",
  Ô: "O",
  Õ: "O",
  Ö: "O",
  Ú: "U",
  Ù: "U",
  Û: "U",
  Ü: "U",
  Ç: "C",
  Ñ: "N",
};

/** Upper-case without accents: how typed names are matched ("média" and "MEDIA" both find AVERAGE). */
export function foldName(name: string): string {
  const upper = name.toUpperCase();
  let out = "";
  for (const c of upper) out += ACCENTS[c] ?? c;
  return out;
}

let fromPt: Map<string, string> | null = null;

function ptIndex(): Map<string, string> {
  if (fromPt) return fromPt;
  const index = new Map<string, string>();
  for (const [pt, en] of Object.entries(PT_ALTERNATES)) {
    index.set(pt, en);
    index.set(foldName(pt), en);
  }
  // The table's own names win over alternates that fold the same.
  for (const [en, pt] of Object.entries(PT_NAMES)) {
    index.set(foldName(pt), en);
    index.set(pt, en);
  }
  fromPt = index;
  return index;
}

/** The canonical name for a name typed in Portuguese (with or without accents), or null when it isn't one. */
export function canonicalFromPt(name: string): string | null {
  const index = ptIndex();
  return index.get(name.toUpperCase()) ?? index.get(foldName(name)) ?? null;
}

/** A canonical name in Portuguese; names without a Brazilian name (and unknown ones) stay as they are. */
export function ptNameOf(canonical: string): string {
  return PT_NAMES[canonical] ?? canonical;
}
