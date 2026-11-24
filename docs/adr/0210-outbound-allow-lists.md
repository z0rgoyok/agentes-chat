# 0210. Private networks a self-hosted server may reach: allow-lists

- Status: Accepted
- Date: 2026-11-20
- Extends: ADR 0019 (`outboundFetch` and the private switch), ADR 0144 (`publicHttpsFetch`), ADR 0146
  (`MODEL_ENDPOINTS_PRIVATE`, `allowsPrivateEndpoints`)
- Code: `packages/engine/src/net-guard.ts` (`allowOutbound`, `refusedAddress`, `alwaysBlocked`,
  `internalNameRefused`; `assertPublicHttpsUrl`, `publicHostAddress`, `publicHttpsFetch`), `packages/engine/src/mail/
  accounts.ts` (custom mail hosts through `publicHostAddress`), `packages/config/src/schema.ts`
  (`OUTBOUND_ALLOW_HOSTS`, `OUTBOUND_ALLOW_CIDRS`), `apps/server/src/start.ts` (set at boot, cleared at shutdown),
  `apps/server/src/app.ts` (a refusal logged), `packages/client/src/lib/errors.ts` (`url.internal` →
  `errors.said.privateNetwork`)

## Context

Addresses a workspace types (a custom MCP server and its sign-in, its own bucket, a database, a mail server, a
password manager) are guarded against SSRF: private, loopback, link-local, metadata, CGNAT and reserved addresses
are refused. A self-hosted server lets workspaces reach its own network with the private switch
(`allowsPrivateEndpoints`: self-hosted and closed to sign-up, or `MODEL_ENDPOINTS_PRIVATE=true`). Its documentation
said it covered custom MCP servers, but only the fetch followed it (`outboundFetch` is the plain `fetch` then): the
check made when the address is typed (`assertPublicHttpsUrl`) still refused every private address, so a server on a
Tailscale tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) or a LAN couldn't be added, with no setting to allow
it. A server open to sign-up had no way to allow one network without opening all of them. The apps said only
"Check the address", and the server logged nothing.

## Decision

1. **The private switch doesn't open typed addresses.** `assertPublicHttpsUrl`, `publicHttpsFetch` and
   `publicHostAddress` refuse private addresses whatever the switch says: it is on by default on a self-hosted
   server closed to sign-up, and the check also guards the pages agents read, on an address a model chose. A
   self-hoster opts in by naming the networks instead (2).
2. **Allow-lists.** `OUTBOUND_ALLOW_HOSTS` (names, or `*.` and a suffix of two
   labels or more) and `OUTBOUND_ALLOW_CIDRS` (ranges or addresses), set by the operator, let a private address
   through every typed-address guard: `assertPublicHttpsUrl`, `publicHttpsFetch` (checked and pinned at every
   connection as before) and `publicHostAddress` (also the mail server's check at every IMAP connection, in
   `start.ts`). A host on the list may resolve to any private address; a range lets
   its addresses through whatever the name. Unset, nothing changes. agentes.chat Cloud ignores both, with a warning
   at boot.
3. **Checked at connect time.** With either list set, `outboundFetch` is always the pinned `publicHttpsFetch`,
   also with the private switch on (where it is otherwise the plain `fetch`): a name that passed the check and then
   resolves to a metadata or an unlisted address (DNS rebinding) is refused when it connects.
4. **Some addresses never pass.** Loopback and unspecified addresses, link-local ones (the cloud metadata address
   `169.254.169.254` among them), AWS's `fd00:ec2::254` and Alibaba's `100.100.100.200` (inside Tailscale's
   range), multicast and reserved addresses, and the names `localhost`
   and `*.localhost` stay refused even inside an allowed range or behind an allowed name, also with the switch on.
   An IPv4 address carried in IPv6 is judged as the IPv4 address.
5. **Addresses named by someone outside stay public.** An OAuth client's metadata document (`fetchPublicDocument`),
   named by whoever registers a client, follows neither the switch nor the lists. Nor does the question whether
   the internet reaches this server's own address (`publicHostAddress` with `internet`: pictures in emails,
   apps that call from their own servers): a server on its tailnet stays private to those.
6. **The refusal says why.** `url.internal` carries the host. The server logs it as a warning with the route and the
   two settings, and the apps say the address is on a private network: use a public one, or on a self-hosted server allow it with
   `OUTBOUND_ALLOW_CIDRS`.

## Consequences

- A self-hosted server connects an MCP server on its tailnet with `OUTBOUND_ALLOW_CIDRS=100.64.0.0/10,fd7a:115c:a1e0::/48`
  (or `OUTBOUND_ALLOW_HOSTS=*.<tailnet>.ts.net`), whatever the switch and sign-up say.
- A host suffix trusts DNS for every name under it: anyone who can make a name there can point it at the server's
  network. The setting's description says to name a narrow suffix.
- `assertPublicHttpsUrl` also guards the pages agents read and the skills they fetch, so what the lists allow, an
  agent may open too. The lists are the operator's to keep narrow.
- The switch's plain `fetch` stays where no list is set, so a self-hosted server that reached public addresses
  through a proxy the plain `fetch` honours keeps doing so.
