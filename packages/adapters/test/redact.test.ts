import { expect, test } from "bun:test";
import { errorLineOf, maskSecretFields, redactCommon } from "../src/redact";

test("a crash's error line, without its stack frames or the Node.js version it ends with", () => {
  const crash = [
    "node:internal/modules/cjs/loader:1228",
    "  throw err;",
    "  ^",
    "",
    "Error: Cannot find module '/x/cli.js'",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
    "    at /usr/lib/node_modules/x/cli.js:1:2",
    "    at file:///usr/lib/x.mjs:3:4",
    "",
    "Node.js v22.1.0",
  ].join("\n");
  expect(errorLineOf(crash)).toBe("Error: Cannot find module '/x/cli.js'");
  expect(errorLineOf("TypeError: boom    at f (/a/b.js:1:2)")).toBe("TypeError: boom");
  expect(errorLineOf("just one line\n")).toBe("just one line");
  expect(errorLineOf("")).toBe("");
});

test("cmd.exe's not found wrapped over two lines comes whole, so it names the program", () => {
  expect(
    errorLineOf(
      "'node' não é reconhecido como um comando interno\r\nou externo, um programa operável ou um arquivo em lotes.\r\n",
    ),
  ).toBe("'node' não é reconhecido como um comando interno ou externo, um programa operável ou um arquivo em lotes.");
  expect(
    errorLineOf("'node' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n"),
  ).toBe("'node' is not recognized as an internal or external command, operable program or batch file.");
  expect(errorLineOf("Done.\nlast words")).toBe("last words");
  expect(errorLineOf("first\nSecond")).toBe("Second");
  expect(errorLineOf("first line\nsecond line")).toBe("second line");
  expect(
    errorLineOf('Der Befehl "node" ist entweder falsch geschrieben oder\r\nkonnte nicht gefunden werden.\r\n'),
  ).toBe('Der Befehl "node" ist entweder falsch geschrieben oder konnte nicht gefunden werden.');
});

test("output full of spaces is read in linear time", () => {
  const spaces = " ".repeat(200_000);
  const started = performance.now();
  expect(errorLineOf(`${spaces}x${spaces}`)).toBe("x");
  expect(errorLineOf(`Error: late${"\n ".repeat(50_000)}at`)).toBe("Error: late");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("text made of values that never end is masked in linear time", () => {
  const filled = (piece: (n: number) => string) => {
    let text = "";
    for (let n = 1; text.length < 1_000_000; n++) text += piece(n);
    return text;
  };
  // Each value opens with a quote written as no other is, so none ends another: one more backslash each time, one
  // more `%25`, one more zero in an entity. And text with a credential on every line, for what a real megabyte costs.
  const megabytes = [
    filled((n) => `token=${"\\".repeat(n)}"x `),
    filled((n) => `"token":${"\\".repeat(2 * n)}'x `),
    filled((n) => `token%${"25".repeat(n)}22:%${"25".repeat(n)}22x `),
    filled((n) => `token&#${"0".repeat(n)}34;:&#${"0".repeat(n)}34;x `),
    filled((n) => `[["token",${"\\".repeat(n)}"x `),
    filled((n) => `"name":"token","value":${"\\".repeat(2 * n)}'x `),
    filled(
      (n) => `{"id":${n},"token":"fake-${n}","body":"{\\"password\\":\\"fake ${n}\\"}","env":"API_KEY=fake${n}"}\n`,
    ),
  ];
  for (const text of megabytes) {
    const started = performance.now();
    expect(redactCommon(text)).not.toBe(text);
    expect(performance.now() - started).toBeLessThan(250);
  }
});

/** `text` written as a JSON string `times` over: each time doubles the backslashes before a quote and adds one. */
const written = (text: string, times: number): string =>
  times === 0 ? text : written(JSON.stringify(text), times - 1);

test("a credential is masked as JSON writes it too, and under a field named for one at any depth", () => {
  const json = [
    '{"user":"ana","password":"hunter2-fake"}',
    '{"x-api-key": "fake-header-key", "client_secret":"fake \\" secret"}',
    '{"access_token":"fake-access","refresh_token":"fake-refresh","max_tokens":4096}',
    "password=hunter2-fake token: 'a b' tokens: 12",
  ].join("\n");
  expect(redactCommon(json)).toBe(
    [
      '{"user":"ana","password":***}',
      '{"x-api-key": ***, "client_secret":***}',
      '{"access_token":***,"refresh_token":***,"max_tokens":4096}',
      "password=*** token: *** tokens: 12",
    ].join("\n"),
  );
  // In text a value is masked up to its first space: by its field, all of it, at any depth.
  expect(
    maskSecretFields({
      q: "launch",
      password: "correct horse fake",
      auth: { username: "ana", accessToken: { value: "a b", expiresIn: 3600 } },
      headers: [{ "x-api-key": "fake-key" }, { Authorization: "fake raw value", Cookie: "session=fake" }],
      env: { AWS_SECRET_ACCESS_KEY: "fake-aws-secret", secretKey: "fake secret key", passphrase: "fake phrase" },
    }),
  ).toEqual({
    q: "launch",
    password: "***",
    auth: { username: "ana", accessToken: { value: "***", expiresIn: 3600 } },
    headers: [{ "x-api-key": "***" }, { Authorization: "***", Cookie: "***" }],
    env: { AWS_SECRET_ACCESS_KEY: "***", secretKey: "***", passphrase: "***" },
  });
  expect(maskSecretFields("password: x")).toBe("password: x");
});

test("a record's texts go through the text rule as themselves, and a text that is itself JSON is opened", () => {
  // Written as JSON the three lines are one word; read as they are, each name has its value.
  const file = { path: "config.yml", content: "token: fake-a\npassword: fake-b\nport: 1" };
  const masked = { path: "config.yml", content: "token: ***\npassword: ***\nport: 1" };
  expect(maskSecretFields({ files: [file] }, redactCommon)).toEqual({ files: [masked] });
  expect(maskSecretFields(JSON.stringify({ files: [file] }), redactCommon)).toBe(JSON.stringify({ files: [masked] }));
  expect(maskSecretFields({ body: `{"a": {"password": "fake x y"}, "n": 1}` })).toEqual({
    body: '{"a":{"password":"***"},"n":1}',
  });
  // One that holds no credential stays as it was written, its layout and its long number too.
  const plain = '{ "id": 12345678901234567890, "note": "kept" }';
  expect(maskSecretFields(plain, redactCommon)).toBe(plain);
  expect(maskSecretFields("[not json, token: fake-a", redactCommon)).toBe("[not json, token: ***");

  // A body inside a body is opened four times over, a text of up to a million characters, one nested too deep to
  // walk never: what is not opened is left to the text rule.
  const nested = (times: number): string =>
    times === 0 ? '{"note":"token: fake-a\\nport: 1"}' : JSON.stringify({ body: nested(times - 1) });
  // A rule that knows a text read as itself by its real line end.
  const asItself = (text: string) => (text.includes("\n") ? "***" : text);
  const opened = (text: string) => !String(maskSecretFields(text, asItself)).includes("fake-a");
  expect([3, 4].map((times) => opened(nested(times)))).toEqual([true, false]);
  const long = (chars: number) => `{"note":"token: fake-a\\nport: 1","pad":"${"x".repeat(chars)}"}`;
  expect([900_000, 1_000_000].map((chars) => opened(long(chars)))).toEqual([true, false]);
  const deep = `${"[".repeat(200_000)}{"password":"fake deep"}${"]".repeat(200_000)}`;
  expect(String(maskSecretFields(deep, redactCommon))).not.toContain("fake deep");
});

test("three shapes only a record can tell: an option's value in a list, a pair, and a record that names its value", () => {
  expect(maskSecretFields({ argv: ["mysql", "--password", "fake a", "--api-key", "--verbose", "-token", 5] })).toEqual({
    argv: ["mysql", "--password", "***", "--api-key", "--verbose", "-token", 5],
  });
  // A number after a name in the plural sets a count.
  expect(maskSecretFields(["llm", "--max-tokens", "4096", "--tokens", "fake a", "--token", "1234"])).toEqual([
    "llm",
    "--max-tokens",
    "4096",
    "--tokens",
    "***",
    "--token",
    "***",
  ]);
  expect(
    maskSecretFields([
      ["x-api-key", "fake a"],
      ["Set-Cookie", "sid=fake"],
      ["accept", "text/plain"],
      ["max_tokens", "4096"],
    ]),
  ).toEqual([
    ["x-api-key", "***"],
    ["Set-Cookie", "***"],
    ["accept", "text/plain"],
    ["max_tokens", "4096"],
  ]);
  // A list of two texts is a name and its value only in a list of such lists: alone it is two names.
  const names = {
    required: ["password", "email"],
    sort: ["token", "asc"],
    labels: ["secret", "ops"],
    allowedHeaders: ["Authorization", "Content-Type"],
    rows: [["token", "of three", "stays"]],
  };
  expect(maskSecretFields(names)).toEqual(names);
  expect(
    maskSecretFields({
      columns: [
        ["password", "character varying"],
        ["api_key", "text"],
      ],
    }),
  ).toEqual({
    columns: [
      ["password", "***"],
      ["api_key", "***"],
    ],
  });
  expect(
    maskSecretFields([
      { name: "Authorization", value: "fake a" },
      { Key: "x-api-key", Value: { raw: "fake b", n: 1 } },
      { header: "Cookie", value: "sid=fake", sent: true },
      { name: "Accept", value: "text/plain" },
      { name: "next_page_token", value: "fake-cursor" },
      { title: "password", value: "of another field" },
    ]),
  ).toEqual([
    { name: "Authorization", value: "***" },
    { Key: "x-api-key", Value: { raw: "***", n: 1 } },
    { header: "Cookie", value: "***", sent: true },
    { name: "Accept", value: "text/plain" },
    { name: "next_page_token", value: "fake-cursor" },
    { title: "password", value: "of another field" },
  ]);
});

test("a credential written as JSON inside a string is masked, however many times that string was written as JSON", () => {
  // One backslash before each quote, then three, then seven: JSON in JSON in JSON.
  for (const name of ["token", "access_token", "api_key", "password", "secret"]) {
    for (const times of [0, 1, 2, 3]) {
      const record = (value: string) => written(JSON.stringify({ user: "ana", [name]: value, n: 1 }), times);
      expect({ name, times, masked: redactCommon(record('fake "quoted" value \\')) }).toEqual({
        name,
        times,
        masked: record("@@").replace(/\\*"@@\\*"/, "***"),
      });
    }
  }
  const once = String.raw`{"status":200,"body":"{\"access_token\":\"fake-in-a-body\",\"expires_in\":3600}"}`;
  expect(redactCommon(once)).toBe(String.raw`{"status":200,"body":"{\"access_token\":***,\"expires_in\":3600}"}`);
  // A value cut off before its closing quote is masked as far as it goes; one whose string ended first, to there.
  expect(redactCommon('{"access_token":"fake-cut-off')).toBe('{"access_token":***');
  expect(redactCommon(String.raw`{"body":"{\"token\":\"fake-cut","status":200}`)).toBe(
    String.raw`{"body":"{\"token\":***,"status":200}`,
  );
});

test("a count of tokens is no credential, nor is a number, a switch, nothing or a page cursor under a credential's name", () => {
  const counts = {
    max_tokens: 4096,
    input_tokens: 12,
    output_tokens: 3,
    total_tokens: 15,
    prompt_tokens: 12,
    completion_tokens: 3,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    maxOutputTokens: 4096,
  };
  const shown = [
    JSON.stringify(counts),
    written(JSON.stringify({ usage: counts }), 2),
    Object.entries(counts)
      .map(([name, n]) => `${name}=${n} ${name}: ${n}`)
      .join("\n"),
    '{"token":5,"secret":false,"password":null,"api_key":true,"user":"ana"}',
    '{"password":"","user":"ana"}',
    '{"next_page_token":"fake-cursor","nextPageToken":"fake-cursor","token_type":"bearer","credentials":"include"}',
  ];
  for (const text of shown) expect(redactCommon(text)).toBe(text);
  const record = {
    usage: counts,
    tokens: { input: 12, output: 3 },
    token: 5,
    secret: false,
    password: null,
    api_key: "",
    next_page_token: "fake-cursor",
    token_type: "bearer",
    bypass: "never",
  };
  expect(maskSecretFields(record)).toEqual(record);
});

test("a page cursor reads as it is, as a JSON field and as a record's, in any case", () => {
  const cursors = [
    "next_page_token",
    "nextPageToken",
    "pagination_token",
    "paging_token",
    "skipToken",
    "$skiptoken",
    "deltaToken",
    "resumeToken",
    "StartingToken",
    "scroll_token",
    "after_token",
    "before_token",
    "offset_token",
  ];
  for (const name of cursors.flatMap((cursor) => [cursor, cursor.toLowerCase(), cursor.toUpperCase()])) {
    const record = { items: [], [name]: "fake-cursor" };
    expect({ name, text: redactCommon(JSON.stringify(record)) }).toEqual({ name, text: JSON.stringify(record) });
    expect(maskSecretFields(record)).toEqual(record);
  }
  // A credential's name that only holds such a word is still one.
  expect(redactCommon('{"reset_token":"fake-a","api_token":"fake-b"}')).toBe('{"reset_token":***,"api_token":***}');
});

test("the same credential as other writers spell it", () => {
  const spelled: [text: string, masked: string][] = [
    // A Python dict, a Ruby hash.
    ["{'access_token': 'fake py', 'n': 1}", "{'access_token': ***, 'n': 1}"],
    ["'password' => 'fake rb', 'n' => 1", "'password' => ***, 'n' => 1"],
    // JSON in an address's query, and a name=value pair in an address inside one.
    [
      "https://app.example.com/x?state=%7B%22token%22%3A%22fake-url%22%2C%22n%22%3A1%7D&a=1",
      "https://app.example.com/x?state=%7B%22token%22%3A***%2C%22n%22%3A1%7D&a=1",
    ],
    [
      "https://app.example.com/cb?next=https%3A%2F%2Fb.example.com%2F%3Ftoken%3Dfake-url%26a%3D1 then",
      "https://app.example.com/cb?next=https%3A%2F%2Fb.example.com%2F%3Ftoken%3D*** then",
    ],
    // JSON in a page's attribute, and with its quotes written as their code point.
    [
      'data-x="{&quot;password&quot;:&quot;fake html&quot;,&quot;n&quot;:1}" class',
      'data-x="{&quot;password&quot;:***,&quot;n&quot;:1}" class',
    ],
    [
      '{"body":"{\\u0022api_key\\u0022:\\u0022fake-u\\u0022,\\u0022n\\u0022:1}"}',
      '{"body":"{\\u0022api_key\\u0022:***,\\u0022n\\u0022:1}"}',
    ],
    // A request's body as a web server's log keeps it.
    ["body: {\\x22password\\x22:\\x22fake log\\x22,\\x22n\\x22:1}", "body: {\\x22password\\x22:***,\\x22n\\x22:1}"],
    // A header inside a string, with a scheme or without, and a shell's quoted value there.
    [
      String.raw`{"headers":"{\"Authorization\":\"Token fake-raw\",\"Cookie\":\"sid=fake\",\"accept\":\"*/*\"}"}`,
      String.raw`{"headers":"{\"Authorization\":***,\"Cookie\":***,\"accept\":\"*/*\"}"}`,
    ],
    [
      String.raw`{"command":"curl -H \"Authorization: Bearer fake-bearer-0000\" https://api.example.com"}`,
      String.raw`{"command":"curl -H \"Authorization: Bearer ***\" https://api.example.com"}`,
    ],
    [String.raw`{"command":"export TOKEN=\"fake with space\" && run"}`, '{"command":"export TOKEN=*** && run"}'],
    // A value on the line after its name; and a name left empty above another credential, which keeps its own value.
    ["password:\n  hunter2-fake\nport: 5432", "password:\n  ***\nport: 5432"],
    ["DB_PASSWORD:\n  API_TOKEN: fake-next-line\n  PORT: 5432", "DB_PASSWORD:\n  API_TOKEN: ***\n  PORT: 5432"],
    // A value on several lines.
    ['"token":\n  "fake first\nfake second",\n"n": 1', '"token":\n  ***,\n"n": 1'],
    // `=` as a JSON writer that escapes HTML writes it.
    [
      '{"body":"grant_type\\u003drefresh_token\\u0026refresh_token\\u003dfake-form ok"}',
      '{"body":"grant_type\\u003drefresh_token\\u0026refresh_token\\u003d*** ok"}',
    ],
    // A bearer value whose slashes are written `\/`.
    [
      String.raw`{"h":"Authorization: Bearer ab\/cdefgh\/fake+bearer==","n":1}`,
      '{"h":"Authorization: Bearer ***","n":1}',
    ],
    // What is glued to a quoted value is one word with it, up to what ends a word.
    [String.raw`export TOKEN=\"fake-a\"fake-b && run`, "export TOKEN=*** && run"],
    [
      `TOKEN='fake a'fake-b; n=1 (token="fake-a") {token: "fake-a", n: 1}`,
      "TOKEN=***; n=1 (token=***) {token: ***, n: 1}",
    ],
  ];
  for (const [text, masked] of spelled) expect(redactCommon(text)).toBe(masked);
});

test("a value ends at a line end or a tab as JSON writes them, and the next line's name and value are read on their own", () => {
  // Text that holds JSON and is not JSON itself: a message quoting a record, a command, a result cut off.
  const written: [text: string, masked: string][] = [
    [
      String.raw`it sent {"content":"token: fake-a\npassword: fake-b\nport: 1"} and failed`,
      String.raw`it sent {"content":"token: ***\npassword: ***\nport: 1"} and failed`,
    ],
    [
      String.raw`printf 'token: fake-a\npassword: fake-b\n' > .env`,
      String.raw`printf 'token: ***\npassword: ***\n' > .env`,
    ],
    [
      String.raw`{"raw":"x-api-key: fake-a\r\nx-auth-token: fake-b\r\naccept: text/plain`,
      String.raw`{"raw":"x-api-key: ***\r\nx-auth-token: ***\r\naccept: text/plain`,
    ],
    [
      String.raw`{"raw":"token: fake-a\tpassword: fake-b\tport: 1`,
      String.raw`{"raw":"token: ***\tpassword: ***\tport: 1`,
    ],
    // Written twice, and four times over.
    [
      String.raw`API_TOKEN = fake-a\\nDB_PASSWORD = fake-b\\\\nPORT = 1`,
      String.raw`API_TOKEN = ***\\nDB_PASSWORD = ***\\\\nPORT = 1`,
    ],
  ];
  for (const [text, masked] of written) expect(redactCommon(text)).toBe(masked);
});

test("an unquoted value ends at the quote that closes the string it sits in, and the next string's is read on its own", () => {
  const strings: [text: string, masked: string][] = [
    [
      'it sent {"old":"password: fake-a","new":"password: fake-b"} and failed',
      'it sent {"old":"password: ***","new":"password: ***"} and failed',
    ],
    ['["-H","X-Api-Key: fake-a","-H","X-Auth-Token: fake-b"]', '["-H","X-Api-Key: ***","-H","X-Auth-Token: ***"]'],
    ['{"token: fake-a":"password: fake-b"', '{"token: ***":"password: ***"'],
    // Behind quotes written with backslashes, and in single quotes.
    [
      String.raw`{\"a\":\"token: fake-a\",\"b\":\\\"password: fake-b\\\"}`,
      String.raw`{\"a\":\"token: ***\",\"b\":\\\"password: ***\\\"}`,
    ],
    ["{'a': 'token: fake-a', 'b': 'password: fake-b'}", "{'a': 'token: ***', 'b': 'password: ***'}"],
    // A quote with the value going on after it ends nothing.
    ['password=fake"a token=fake\\"b next', "password=*** token=*** next"],
    // A quoted value cut off before its closing quote goes as far as it did, whatever it starts with.
    ['{"access_token":",fake-cut-off', '{"access_token":***'],
  ];
  for (const [text, masked] of strings) expect(redactCommon(text)).toBe(masked);
});

test("a quote ends an unquoted value only inside a string: with none open before it, the quote is the value's own", () => {
  const whole: [text: string, masked: string][] = [
    ['export DB_PASSWORD=fake-ab",cd-tail', "export DB_PASSWORD=***"],
    ["export DB_PASSWORD=fake-ab',cd-tail", "export DB_PASSWORD=***"],
    ['password: fake-ab"}cd-tail next', "password: *** next"],
    ['token=fake-ab"]cd-tail', "token=***"],
    ['api_key: fake-ab":cd-tail', "api_key: ***"],
    // A quote of the other kind, or written another way, is not the one that is open.
    [`{"env":"PASSWORD=fake-ab',cd-tail"}`, '{"env":"PASSWORD=***"}'],
    [
      String.raw`it sent {"note":"password=fake-ab\",cd-tail"} and failed`,
      'it sent {"note":"password=***"} and failed',
    ],
    // A written quote after a bare name opens a value only inside a string: with none open it is the value's own.
    [String.raw`export DB_PASSWORD=\"fake-ab\",cd-tail`, "export DB_PASSWORD=***"],
    [String.raw`API_TOKEN: \'fake-ab\'}cd-tail next`, "API_TOKEN: *** next"],
    [
      String.raw`it sent {"cmd":"export DB_PASSWORD=\"fake a\" && run"} and failed`,
      'it sent {"cmd":"export DB_PASSWORD=*** && run"} and failed',
    ],
  ];
  for (const [text, masked] of whole) expect(redactCommon(text)).toBe(masked);
});

test("a record that names its value and a list of pairs are read in text that keeps them as JSON wrote them", () => {
  const records: [text: string, masked: string][] = [
    [
      'it sent [{"name":"X-Api-Key","value":"fake a"},{"Key":"Cookie","Value":"sid=fake"},{"header":"authorization", "value": "fake-b"}] and',
      'it sent [{"name":"X-Api-Key","value":***},{"Key":"Cookie","Value":***},{"header":"authorization", "value": ***}] and',
    ],
    [
      'headers [["x-api-key","fake a"],["accept","text/plain"], [ "Set-Cookie" , "sid=fake" ]] sent',
      'headers [["x-api-key",***],["accept","text/plain"], [ "Set-Cookie" , *** ]] sent',
    ],
    // Behind quotes written with backslashes.
    [
      String.raw`{"body":"{\"name\":\"Authorization\",\"value\":\"fake a\"}","rows":"[[\"api_key\",\"fake b\"]]"`,
      String.raw`{"body":"{\"name\":\"Authorization\",\"value\":***}","rows":"[[\"api_key\",***]]"`,
    ],
    // Beside a list whose texts hold quotes of their own, and before one the text was cut in: still a pair.
    [
      String.raw`[["sec-ch-ua","\"Chromium\";v=\"120\""],["cookie","sid=fake"],["accept","*/*"]] then [["x-api-key","fake a"],["acc`,
      String.raw`[["sec-ch-ua","\"Chromium\";v=\"120\""],["cookie",***],["accept","*/*"]] then [["x-api-key",***],["acc`,
    ],
  ];
  for (const [text, masked] of records) expect(redactCommon(text)).toBe(masked);
  // A name that is no credential's, a page cursor, a value that is no text, another field's name, a list of two
  // texts that neither starts a list nor follows another, a list that goes on past its second text, and a list of
  // two texts beside one that has one text or three.
  const plain = [
    '{"rows":[["token","name","date"]],"fields":[["id"],["token","asc"]],"sort":[["secret","desc"],["id"]]}',
    '[["a","b","c"],["password","text"]]',
    '{"name":"Accept","value":"text/plain"},{"name":"next_page_token","value":"fake-cursor"}',
    '{"name":"token","value":5},{"title":"password","value":"of another field"},{"username":"secret","value":"x"}',
    '{"required":["password","email"],"sort":["token","asc"],"allowedHeaders":["Authorization","Content-Type"]}',
    '[["accept","text/plain"],["max_tokens","4096"]]',
  ];
  for (const text of plain) expect(redactCommon(text)).toBe(text);
});
