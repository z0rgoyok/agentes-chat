/**
 * Records that hold a credential below their top level, where JSON writes a line end, a tab and a quote as
 * backslashes and a rule for text reads one long word. Wherever such a record is read out as text, `HIDDEN` is gone
 * and what the shape names stays. Written as text the record is read once more by the rule for text, where a masked
 * value loses its quotes (`"--password",***`).
 */
export const HIDDEN = ["fake-first-value", "fake-second-value"] as const;
const [first, second] = HIDDEN;

export const SECRET_SHAPES: [shape: string, record: Record<string, unknown>, stays: string[]][] = [
  [
    "a file's lines",
    { file: { path: "config.yml", content: `token: ${first}\npassword: ${second}\nport: 1` } },
    ['"path":"config.yml"', String.raw`"content":"token: ***\npassword: ***\nport: 1"`],
  ],
  [
    "headers as one text",
    { req: { raw: `x-api-key: ${first}\r\nx-auth-token: ${second}\r\n` } },
    [String.raw`"x-api-key: ***\r\nx-auth-token: ***\r\n"`],
  ],
  [
    "a tab between two",
    { req: { raw: `token: ${first}\tpassword: ${second}` } },
    [String.raw`"token: ***\tpassword: ***`],
  ],
  [
    "an env file in a list",
    { files: [{ path: ".env", content: `API_TOKEN = ${first}\nDB_PASSWORD = ${second}\n` }] },
    ['"path":".env"', String.raw`"content":"API_TOKEN = ***\nDB_PASSWORD = ***\n"`],
  ],
  ["an option's value", { exec: { args: `--password ${first} -u ana` } }, ["--password *** -u ana"]],
  [
    "an option's quoted value",
    { exec: { command: `mysql --password "${first} ${second}" -u ana` } },
    ["mysql --password *** -u ana"],
  ],
  // A written line end between a name and its value hides the value from a rule that reads the record as JSON.
  [
    "a value on the line after its name",
    { config: { yaml: `password:\n  ${first}\nport: 1` } },
    [String.raw`"yaml":"password:\n  ***\nport: 1"`],
  ],
  // A text that holds a record of its own and is not one: each of its strings ends at its closing quote.
  [
    "a log line that quotes a record",
    {
      path: "app.log",
      content: `12:00:01 INFO sent {"lines":["token: ${first}","password: ${second}"]}\n12:00:02 INFO ok\n`,
    },
    ["token: ***", "password: ***", "12:00:02 INFO ok"],
  ],
  [
    "a command that sends a record",
    { command: `curl -d '{"a":"token: ${first}","b":"password: ${second}"}' https://example.com` },
    ["token: ***", "password: ***", "https://example.com"],
  ],
  // A number after an option named in the plural sets a count; any other text there is a credential.
  [
    "a count given as an option",
    {
      command: `llm --max-tokens 4096 --tokens ${first} -m x`,
      argv: ["llm", "--max-tokens", "4096", "--api-keys", second],
    },
    ["llm --max-tokens 4096 --tokens *** -m x", '"--max-tokens","4096","--api-keys",***'],
  ],
  // Three shapes only a record can tell.
  [
    "a list of arguments",
    { argv: ["mysql", "--password", first, "--verbose", "-u", "ana"] },
    ['"--password",***,"--verbose","-u","ana"'],
  ],
  [
    "a pair of name and value",
    {
      headers: [
        ["x-api-key", first],
        ["accept", "text/plain"],
      ],
    },
    ['["x-api-key",***],["accept","text/plain"]'],
  ],
  // A list of two texts is a name and its value only in a list of such lists: alone it is two names.
  [
    "lists of names",
    {
      required: ["password", "email"],
      sort: ["token", "asc"],
      labels: ["secret", "ops"],
      allowedHeaders: ["Authorization", "Content-Type"],
    },
    ['["password","email"]', '["token","asc"]', '["secret","ops"]', '["Authorization","Content-Type"]'],
  ],
  [
    "a table's columns",
    {
      columns: [
        ["password", "character varying"],
        ["api_key", "text"],
      ],
    },
    ['[["password",***],["api_key",***]]'],
  ],
  // A list of two texts is a pair among lists of two texts: beside a list of another length, or going on past its
  // second text, it is names. Written as text, the record is read once more, and stays as the record was read.
  [
    "lists that are no pairs",
    {
      fields: [["id"], ["token", "asc"]],
      rows: [["token", "name", "date"]],
      sort: [["secret", "desc"], ["id"]],
    },
    ['[["id"],["token","asc"]]', '[["token","name","date"]]', '[["secret","desc"],["id"]]'],
  ],
  [
    "a record that names its value",
    {
      headers: [
        { name: "Authorization", value: first },
        { key: "Cookie", value: second },
        { name: "Accept", value: "text/plain" },
      ],
    },
    ['"name":"Authorization","value":***', '"key":"Cookie","value":***', '"name":"Accept","value":"text/plain"'],
  ],
];

/**
 * Text that holds a record and can't be opened as one: a message quoting it, a result with words before it, a result
 * cut off. An unquoted value in one of its strings ends at that string's closing quote, and the next string's is
 * read on its own. The three shapes only a record can tell are read where the text keeps them as JSON wrote them.
 * And text that holds no record: a quote there closes no string, and a count is one with a sign after it.
 */
export const UNOPENED: [shape: string, text: string, stays: string[]][] = [
  [
    "an edit, quoted",
    `it sent {"path":"config.yml","old_string":"password: ${first}","new_string":"password: ${second}"} and failed`,
    ['"old_string":"password: ***","new_string":"password: ***"} and failed'],
  ],
  [
    "a list of arguments, quoted",
    `ran ["curl","-H","X-Api-Key: ${first}","-H","X-Auth-Token: ${second}","https://example.com"]`,
    ['"-H","X-Api-Key: ***","-H","X-Auth-Token: ***","https://example.com"]'],
  ],
  [
    // A step keeps a tool's result as text, its first 4,000 characters: a long one that is JSON ends before its end.
    "a result cut off",
    JSON.stringify({
      matches: [
        { file: "config/a.yml", line: `password: ${first}` },
        { file: "config/b.yml", line: `token: ${second}` },
        ...Array.from({ length: 80 }, (_, n) => ({ file: `config/${n}.yml`, line: `port: ${n} of the lines found` })),
      ],
    }).slice(0, 4000),
    ['"line":"password: ***"},{"file":"config/b.yml","line":"token: ***"},{"file":"config/0.yml"'],
  ],
  [
    "a result with words before it",
    `exit 0\n{"stdout":"token: ${first}","stderr":"password: ${second}"}`,
    ['{"stdout":"token: ***","stderr":"password: ***"}'],
  ],
  [
    "an option's value in a list of arguments, quoted",
    String.raw`ran ["mysql","--password","${first}","-u","ana"] and {"args":"[\"psql\",\"--api-key\",\"${second}\"]"} then ["llm","--max-tokens","4096"]`,
    [
      '["mysql","--password",***,"-u","ana"]',
      String.raw`[\"psql\",\"--api-key\",***]`,
      '["llm","--max-tokens","4096"]',
    ],
  ],
  [
    "records that name their values, quoted",
    `it sent [{"name":"X-Api-Key","value":"${first}"},{"key":"Cookie","value":"${second}"},{"name":"Accept","value":"text/plain"}] and failed`,
    ['{"name":"X-Api-Key","value":***},{"key":"Cookie","value":***},{"name":"Accept","value":"text/plain"}'],
  ],
  [
    "a list of pairs, quoted",
    `headers [["x-api-key","${first}"],["accept","text/plain"],["Authorization","${second}"]] and "required":["password","email"]`,
    ['[["x-api-key",***],["accept","text/plain"],["Authorization",***]]', '"required":["password","email"]'],
  ],
  // Outside a string a quote closes nothing: it is the value's own, and what follows it is the credential still.
  [
    "a value that holds a quote, in no string",
    `export DB_PASSWORD=${first}",${second} then mysql --password ${first}'}${second} -u ana`,
    ["export DB_PASSWORD=*** then mysql --password *** -u ana"],
  ],
  [
    "a value that opens with a written quote, in no string",
    String.raw`export API_TOKEN=\"${first}\",${second} then mysql --password \"${first}\"]${second} -u ana`,
    ["export API_TOKEN=*** then mysql --password *** -u ana"],
  ],
  // A count is one still with what closes or ends its command right after it; a text that starts as a number is none.
  [
    "a count with a sign after it",
    `echo $(llm --max-tokens 4096) and llm --max-tokens 4096; echo done, it used --max-tokens 4096. ran llm with --max-tokens 4096, then --tokens 123456:${first} --tokens 12,${second} --api-keys 1234.${first}`,
    [
      "echo $(llm --max-tokens 4096) and llm --max-tokens 4096; echo done, it used --max-tokens 4096. ran llm with --max-tokens 4096, then",
      "--tokens *** --tokens *** --api-keys ***",
    ],
  ],
];

/** What a text shows of `HIDDEN`, and what it lacks of what stays. */
export const shownIn = (text: string, stays: string[]) => ({
  shows: HIDDEN.filter((value) => text.includes(value)),
  lacks: stays.filter((value) => !text.includes(value)),
});
