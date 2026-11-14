# 0181. An operator's own MCP servers are told, verifiably, who is calling

- Status: Accepted
- Date: 2026-11-13
- Code: config `packages/config/src/schema.ts` (`MCP_CALLER_IDENTITY`), `connectors.ts` (`mcpCallerIdentity`);
  engine `packages/engine/src/connectors/mcp.ts` (`callerStatement`, `CALLER_META_KEY`, `McpSession.callTool`'s
  `meta`), `crypto.ts` (`signJwtHs256`); server `apps/server/src/engine.ts`; tests
  `packages/engine/test/mcp-caller-identity.test.ts`, `packages/config/src/index.test.ts`

## Context

A workspace connects an MCP server by address (ADR 0016) with nothing, with one key sent as
`Authorization: Bearer <key>`, or with the server's own OAuth. The server process makes every call, and a call says
nothing of who is behind it: not the workspace, the agent, the run, nor the person the run acts for. The key is all
the server has to go on, and a key that leaks works from any other workspace of the instance (anyone can connect the
same address with it) and from anywhere else on the internet.

A public service has accounts of its own, so that is enough for it. It is not enough for a tool the operator of an
instance runs for their own workspace: an internal tool that should answer that workspace's agents and nobody
else's, perhaps only some of them, and whose own log should say which agent asked, in which run and for whom.

## Decision

1. **One optional setting names the servers.** `MCP_CALLER_IDENTITY` is a comma-separated list of `host=secret`
   pairs: a bare lower-case host name, and a secret of at least 32 characters that the server at that host holds too.
   A malformed value, or a host named twice, stops the server at boot like any other setting. It is marked secret, so
   it is masked wherever the configuration is printed. Unset, nothing changes for anyone.

2. **A tool call to a listed host carries a signed statement.** For a server connected by address whose host is in
   the list, every `tools/call` the server process sends has, in the request's `params._meta`, the key
   `chat.agentes/caller` with a compact JWS: header `{"alg":"HS256","typ":"JWT"}`, signed with that host's secret
   (its UTF-8 bytes), and these claims:

   | Claim | What it is |
   | --- | --- |
   | `iss` | The instance's public origin (`PUBLIC_URL`) |
   | `aud` | The server's host, lower case |
   | `org` | The calling workspace's id |
   | `agent` | The agent's id |
   | `run` | The run's id; absent for a call made outside any run (a mission task's executor) |
   | `conn` | The connection's id |
   | `user` | The id of the person the run acts for; absent when nobody is behind it (a routine's run, an unattended one) |
   | `iat`, `exp` | When it was made, and 60 seconds later |
   | `jti` | A random id, new for every call |

   `user` comes from where the audit log's `tool.call` row takes the person behind a run (`runAuthorityById`), so the
   server's log and the workspace's audit log name the same person.

3. **It goes beside the arguments, never in them.** The arguments are the agent's own words: they are what an
   approval card shows and what the run's steps and the audit log keep. The statement is in none of those, and no API
   returns it. `_meta` is where the protocol lets a client add what the tool's schema doesn't know.

4. **Only where it means something.** Never on `initialize` or `tools/list`: the server process lists a server's
   tools outside any run, for every agent of the workspace at once, so there is no caller to name. Never to a catalog
   connector or a service through Composio, which other companies run. Never to a host that isn't listed: a host is
   matched by its whole name, so a parent domain or a neighbour covers nothing. Never over http, where anyone on the
   way could read the statement and send it again within its life, and never to a port other than https's own: the
   list holds bare names, so the audience is exactly one origin. The one call made to a server by address outside an
   agent's work (asking a one-click service which account a new sign-in reached) carries none either.

5. **One place signs.** The connector tool source's `execute` for a server by address, which the Tool Gateway calls
   with the run's context. Both kinds of agent go through it: the model loop in the server, and a vendor CLI on a
   computer, whose tool calls come back through the runner's bridge (ADR 0032).

6. **A shared secret per host, not a key pair of the instance.** The operator runs both ends, so a secret in both
   environments needs no endpoint to publish keys and no library to check with: the server verifies with an HMAC.
   What it costs is that the server could sign statements itself, which only lets it lie to its own log. Each host has
   its own secret, so one listed server can't make statements another would accept. Statements a third party could
   check (signed with a key pair, the public half served by the instance) wait for a server that needs them.

7. **What the server checks.** The signature under its secret, with the algorithm pinned to HS256; `aud` equal to
   its own host and `iss` to the instance it expects; `exp` not passed, with little slack for clocks; a `jti` it
   hasn't seen within the statement's life, so each is used once; then `org` and `agent` against whatever its key is
   meant to serve. A call it refuses should come back as a tool error: an HTTP 401 tells agentes.chat the
   connection's own sign-in stopped working, and it asks a person to reconnect.

## Consequences

- An instance without the setting sends exactly what it sent before, and so does every server that isn't listed. No
  migration, and nothing new in the apps: this is the operator's setting, and a workspace's admins connect such a
  server the way they connect any other.
- A leaked key alone no longer opens a server that checks the statement: a call from another workspace names that
  workspace, and a call from outside the instance has no statement at all.
- Every workspace of the instance that connects a listed address has its calls signed, each with its own ids. The
  server decides which it serves.
- The statement says who calls, not that the call is wise: an agent that text it read talked into calling the tool is
  still that agent. What each agent may ask stays the server's to decide, and the agent's access in the workspace
  still says which tools it reaches.
- Changing a secret means setting it on both sides and restarting this server; between the two, the other side
  refuses the calls.
