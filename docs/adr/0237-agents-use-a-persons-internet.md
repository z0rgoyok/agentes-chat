# 0237. Agents use a person's internet: a computer lends its connection to the workspace's computer

- Status: Accepted (phase 1: the switch, the relay on both computers and the server; the workspace computer's
  routing is the Cloud's, later)
- Date: 2026-11-24 (amended 2026-11-26: no daily cap; 2026-11-27: self-hosted servers, then servers borrow;
  2026-11-27 b: every TCP port; 2026-11-27 c: AI direct, "use only this computer's internet")
- Extends: ADR 0025 (connected computers), ADR 0058 §11 (data sockets), ADR 0101 (observed egress)
- Code: protocol `packages/adapters/src/machine-protocol.ts` (`EGRESS_SHARE_PROTOCOL`, `EGRESS_SHARE`,
  `egress.dial`, `StreamHello.egress`, `welcome.egressRelay`); db `machines.egress_share`, `egress_share_at`,
  `egress_via` (migration 0350), the notice to computers paired before (migration 0351); engine `packages/engine/src/egress-share.ts` (`lendingComputers`,
  `createEgressRelay`), `devices.ts` (`shareInternet`), `machines.ts` (`egressVia`, `egressViaNow`), `streams.ts`
  (`ClaimedStream.readyLater`), `notifications.ts` (`device.internet_shared`); runner
  `apps/server/runner/egress-share.ts` (the lending side),
  `egress-relay.ts` (the workspace computer's SOCKS5 socket); web `DevicePage.tsx`, `computer/Egress.tsx`,
  `devices/dialogs.tsx`, `pages/ConnectPage.tsx`; phone `ComputerSection.tsx`, `MachineScreen.tsx`; desktop
  `windows/InternetRow.tsx` (after pairing, and in Preferences › This Mac). Self-hosted servers (amendment
  2026-11-27): `EGRESS_PROXY_PROTOCOL`, `welcome.egressProxy`, `egress.proxy`, `EGRESS_DIRECT_HOSTS`; db
  `machines.egress_lent_at` (migration 0365); engine `machines.ts` (`setServerLending`, `serverLending`,
  `borrowsInternet`, `serverBox`, `lendsOffAtHello`), `machine-hub.ts` (the hello's default), `egress-share.ts`
  (`EgressRelay.connect`, `lending`, the pick), `egress-fetch.ts` (`createEgressFetch`), `web-tools.ts` (`lent`), `devices.ts` (`lendsInternet`, `noticeLendingComputers`); server `start.ts` (the boot
  setting and the once-only notice); runner `egress-relay.ts` (`startEgressProxy`, `egressProxyEnv`,
  `egressProxyChromeArgs`), `daemon.ts` (`borrowEgress`), `secrets.ts`, `accounts.ts` (`accountSettingsEnv`),
  `browser.ts` (`chromeLaunchArgs`), `loopback-guard.ts` (`ownServices`), `host.ts` (`egressProxies`); client
  `lib/devices.ts` (`lendsInternet`).

## Context

Some sites answer only visitors from their own country, or treat a datacenter address as a robot. An agent that works
for a person on the workspace's own computer then can't do what the person could do from home. The person's own
computers are already connected (ADR 0025) and hold a socket to the server.

## Decision

1. **The switch.** A person's own computer (`connected`) in a workspace that has its own computer shows "Agents use
   this computer's internet". It is on for every computer. Where a person pairs one (Let it join, the code page, the
   desktop app after pairing) they see that line with its switch, before or as it joins. Computers paired before this
   existed are on too, and their owners hear it once in the inbox (`device.internet_shared`, migration 0351, web and
   phone): "Agents now open websites through the internet of <computer>", what it keeps out (only this workspace's
   agents, only websites, never its own network; offline, the usual way), and one **Turn off** that sets
   the switch off; turning it off anywhere marks the notice done. A computer marked the workspace's, or whose owner
   left, tells who configures the workspace instead. Only the person who connected it turns it on
   (`device.share_owner_only`); an admin may turn it off. Turning it on again picks it first.
2. **Which computer.** The workspace's computer goes out through one computer at a time: among the lending computers
   online with an app that speaks `EGRESS_SHARE_PROTOCOL`, the newest pick (turned on last, else paired last). None
   online: its usual way out. A computer that says it carries enough now is passed over for a minute.
3. **The wire.** The workspace's computer offers its network guard a SOCKS5 socket (`<runner home>/egress-relay.sock`,
   mode 600, CONNECT only, no authentication: root alone reaches it), only when the server says so in `welcome`. Each
   connection there dials a data socket whose `stream.hello` names the destination (`egress`). The server checks it is
   the workspace's own computer, picks the lending computer, and asks it `egress.dial` with a fresh stream id; that
   computer reaches the site, dials its own data socket, and the server joins the two, bytes passed as they come
   (16 MiB queued toward a side at most), and only then answers `stream.ready` to the first. Every hop is a socket that
   already exists, so a computer behind any router lends without opening a port.
4. **What it carries.** TCP to any port but 25 (amendment 2026-11-27 b; until then only ports 80 and 443); UDP keeps
   its usual way.
   The lending computer resolves a name itself (so the site's own location answers; a guard that passes the address its
   agent already resolved gets that address) and refuses a name or address that is not public, or that is on one of
   its own interfaces' subnets (a home's global IPv6 prefix, its router, this computer), wholly; at most 256
   connections at once, with no daily cap on bytes (amendment below). It is new work: a paused computer, or a
   workspace or agent on hold, lends nothing. Never another workspace's: the server pairs only a workspace's computer
   with that workspace's computers.
5. **Falling back.** Nothing lent now, a lending computer offline or asleep, or a refusal, closes the first data socket
   at once with a code the SOCKS socket turns into a reply: `unreachable` → "network unreachable" (go out your usual
   way), `refused` → "not allowed", `notFound` → "host unreachable". Connections already open end with their computer.
6. **Whose, shown.** The server writes, at most once a minute, which computer carried the workspace's computer's last
   connection (`machines.egress_via`). For five minutes after, the computer's page says "Agents use the internet of
   Ana's laptop (Ana)" on the web and the phone, and that computer's page says "In use now"; the observed exit address
   (ADR 0101) then measures through it too, since its probe goes the agents' way.
7. **Both sockets on one server process.** The two data sockets are joined in memory; a lending computer whose socket
   is on another replica isn't reached this way, and the first socket falls back.

## The Cloud's part (not in core)

The workspace computer's guard decides what goes to the socket: for agents' TCP to ports 80 and 443, the socket first;
on "network unreachable", its usual proxy, remembering that for a while so a workspace with no lending computer pays
nothing; UDP to port 443 dropped while a computer lends, so browsers fall back to TCP through it rather than QUIC
through the proxy. Its abuse rules stay in front of the socket, as they are in front of the proxy. That is the Cloud
repository's ADR and change.

## Consequences

- The server carries the bytes of lent connections, with no cap on them.
- A person sees which of their computers lends, and the workspace sees whose internet it uses; both turn it off in one
  switch.
- A self-hosted server lends too (amendment 2026-11-27): to its own computer, to computers marked the workspace's
  that don't lend, and to its own reads of web pages for agents.

## Amendment 2026-11-26: no daily cap

Owner decision: lending has no daily cap. The 5 GB a day both ways that the lending computer counted (UTC, in
`<runner home>/egress-share.json`) is gone from the runner (`EGRESS_SHARE.dailyBytes`), and from every string that
named it (the switch's hint on the web, the phone and the desktop app, and the inbox notice). A permissive default:
the person turns lending off in one switch. The limits that keep it safe stay: only that workspace's agents, only
ports 80 and 443, only public addresses, never one on the lending computer's own network, and 256 connections at
once. A lending computer on an older app keeps the cap until it updates; the server and the protocol are unchanged,
and a file left in the runner's folder is no longer read.

## Amendment 2026-11-27: self-hosted servers

Owner decision: lending works on a self-hosted server too. The main case is a server on a VPS used from the desktop
app on the person's own computer: the agents go out through that computer's internet (a home address, sites that
block datacenters, the person's own location).

1. **Where it is on.** Set once at boot (`setServerLending`): on for every server except one whose computers a
   provisioner makes (`MACHINE_PROVISIONING=external`, the Cloud), where only the managed computer borrows, as
   before. No new setting.
2. **Who borrows** (`borrowsInternet`): the managed computer always; where the server lends, also this server's own
   computer (`host`), with its own switch off a computer marked the workspace's or a server box (§8), and the server
   process itself for its reads of web pages. A computer that lends never borrows (the two need the switch in opposite states, and the
   pick skips the borrower), a person's own computer that doesn't lend doesn't borrow either (turning the switch off
   never starts using a colleague's internet), and a host computer never lends. Anything else asking gets
   `forbidden`, read as "go out your usual way". The lenders are unchanged (§1, §2), and a lending computer at
   protocol 81 to 94 lends to the new borrowers with no change.
3. **What the server sends through a lender, and what never.** Through it: `web_fetch` page reads and the DuckDuckGo
   HTML search page, what sites block on datacenter addresses and what the switch's words name ("only websites").
   They try the lender first and go their usual way once when it fails (no lender now, a refusal, a broken tunnel).
   Never: Brave and SearXNG (keyed or the operator's own services, SearXNG maybe on the server's network), MCP and
   HTTP connector calls, OAuth, storage, webhooks, git hosts, email, model providers, updates and the pictures of
   `show_image`: authenticated or infrastructure calls that need an always-on, stable address (a laptop that sleeps
   would break runs; providers may bind tokens to an address) and are not websites. The server reaches a lent
   connection through a CONNECT proxy on 127.0.0.1 (`egress-fetch.ts`), with Bun's `fetch` `proxy` option and a key
   only this process holds (`Proxy-Authorization: Basic <orgId>:<token>`, a fresh token each start); each tunnel is
   one leg of the relay (`EgressRelay.connect`), paired like a data socket. The lent path doesn't pin the address:
   the URL guard runs first, and the lending computer resolves the name and refuses non-public addresses and its own
   networks, so this server's network is never reached through it.
4. **Borrowing runners** (`EGRESS_PROXY_PROTOCOL`, 95). With no Cloud guard in core, a borrowing runner runs a
   loopback proxy (`<runner home>/egress-proxy.json` keeps its port across restarts) that speaks HTTP CONNECT and
   SOCKS5 on one port, told by `welcome.egressProxy` at connect and by `egress.proxy` when the computer's role
   changes (`updateComputerDevice`; failures ignored, the next `welcome` says it again). Connections to ports 80 and
   443 ask the server for a lent connection (`stream.hello` with `egress`, as the managed computer does); on
   `unreachable`, `forbidden`, a failure here or the server away it goes direct and stays direct for 60 s unasked;
   `refused` goes direct at once; only `notFound` fails the connection. Other ports never ask. Its own direct dial
   reaches public addresses only (root's dial skips the agents' guard). It hands agents' processes
   `HTTPS_PROXY`/`https_proxy` (`http://`), `ALL_PROXY`/`all_proxy` (`socks5h://`), `NODE_USE_ENV_PROXY=1` and
   `NO_PROXY` (loopback, `.local`, `.internal`, the private, CGNAT and link-local ranges, this server's host, and
   `EGRESS_DIRECT_HOSTS`: the AI CLIs' model and sign-in services), through `agentSecrets` (every command, CLI and
   task, both modes; system mode's workers get it in `worker.state`) and Claude Code's `--settings` env, which also
   keeps the turn's endpoint direct. Chrome gets `--proxy-server=socks5://…` (names resolved by the lender), the same
   bypass list and WebRTC kept off UDP outside the proxy. No `HTTP_PROXY`: plain http goes direct but for curl via
   `ALL_PROXY`. Nothing is handed out where the runner itself runs with a proxy of its operator's, or where its agents
   run in a network of their own (`networkLauncher`, `networkMark`). Processes started before keep their environment;
   a proxy turned off stays up and dials direct. The agents' container service never gets it (image pulls through a
   home connection are no help).
5. **Shown.** The lender's row records when it last carried a lent connection, whoever borrowed
   (`machines.egress_lent_at`, at most once a minute per process): "In use now" while that is under five minutes (or
   the managed computer's `egress_via` names it). `egress_via` is written on any borrower's row, so a host or marked
   computer's page says "Agents use the internet of Ana's laptop (Ana)" on the web and the phone. `shareInternet` is
   sent for people's computers wherever the server lends, and the devices list says `lendsInternet`, which the join
   line reads (Let it join, the code page, the phone), with an older server's fallback to "the workspace has its
   own computer". The switch's rules are unchanged (`device.share_owner_only`; an admin only turns it off).
6. **The once-only notice.** A self-hosted server's computers already had the switch on (the column's default) and
   were never told: at the first start that lends, a once-per-database boot task (`noticeLendingComputers`) runs
   migration 0351's insert without asking for a managed computer, so each lending computer's owner hears it once.
   Never on the Cloud.
7. **This server's own computer.** One guard covers every organization's agents there, so each organization's
   runner's proxy port is opened only to that organization's block of uids (`ownServices`, a `ct mark` range rule
   before the shared services). Where agents run as the installing user (the simple mode, a Mac) organizations
   can't be told apart, as for their folders already.
8. **Servers borrow, desktops lend** (same day). The main case pairs a runner on the VPS (or another server-room box)
   and the desktop app on the person's own computer. With the switch on by default and the newest picked, the VPS
   lent, and could be picked over the person's computer. Without the owner marking anything:
   - A server box (`serverBox`) is a connected Linux computer whose runner the agentes.chat app doesn't run
     (`runByApp`: `hello.app` from protocol 87, the older rule before). Where the server lends, its hello turns its
     switch off while its owner never turned it on (`egress_share_at` null, `lendsOffAtHello`), and resolves its
     `device.internet_shared` notice: a newly paired one from its first hello, one paired before at its next, once
     (off, it stays as people set it). It then borrows (§2) without being marked the workspace's. Its owner may turn
     it on to lend; that sets `egress_share_at`, which keeps it. The code page (`/conectar`, which confirms Terminal
     installs; the app confirms its own) starts the switch off for Linux where the server lends (`serverBoxesBorrow`
     in the devices list, `joinLends`) and sends it only when changed there; Let it join, on the web and the phone,
     doesn't say a Linux computer will lend there.
   - The pick (`lendingComputers`) puts computers the app runs before Terminal installs, then the newest as before. An
     older Linux runner that doesn't say (`hello.app`) counts as a Terminal install there.
   - People's own desktops keep the switch on by default (a Mac or PC, and Linux run by the app). A computer still
     never lends and borrows at once (the switch's two states), and the pick skips the borrower.
   - Never on the Cloud (`MACHINE_PROVISIONING=external`): the hello leaves the switch alone and the pick stays
     newest first. No protocol change: the runner already says `hello.app` and takes `welcome.egressProxy`.

Consequences: lent bytes of runner traffic cross the server twice, still with no cap; both connections must reach
the same server process, else the borrower goes direct (§7); a Linux person who runs the runner from the Terminal on their own desktop has
it borrow until they turn the switch on (§8); the env proxy is cooperative, not a security boundary.

## Amendment 2026-11-27 b: every TCP port

Owner decision: SSH, git over SSH, databases and any other TCP go through the lending computer too, not only the web.

1. **The ports** (`EGRESS_ANY_PORT_PROTOCOL`, 96). `isEgressTarget` takes any TCP port but `EGRESS_SHARE.refusedPorts`
   (25: a home address sending mail straight to mail servers is how it lands on spam blocklists; 465 and 587, mail
   sent through the person's own provider with a sign-in, go through if the person's network allows them). The
   lending computer keeps every other refusal (non-public addresses, its own subnets, 256 connections at once).
2. **Older lenders.** A lending computer before protocol 96 refuses anything but 80 and 443 (`bad_request`). The
   server sends it nothing else (`lenderCarries`): for another port it picks the newest lender that carries it, and
   while only older ones are online it answers `refused` ("not carried"), never `unreachable`, so the borrower keeps
   asking for its web connections instead of going quiet for a minute.
3. **Borrowers ahead of their server.** A server before this rejects a hello naming another port with `badRequest`.
   The workspace computer's socket answers that "not allowed" and a self-hosted borrower's proxy goes direct for that
   connection only, both without the minute of quiet.
4. **The Cloud's guard** sends every agent TCP connection but port 25 to the socket first (the Cloud's ADR 0009), so
   on the Cloud it is transparent: any program, no settings. **A self-hosted borrower** has no guard: its proxy now
   asks for any port, but only programs that use the proxy settings reach it (browsers, `HTTPS_PROXY`/`ALL_PROXY`
   readers: git over HTTPS, curl, most CLIs). OpenSSH, database clients and others that ignore them go out the usual
   way. `notFound` still fails a web connection, but another port the lending computer couldn't reach (its network
   may block SSH or a database's port) goes the borrower's own way, as it did before every port was lent. Left out:
   an SSH `ProxyCommand` through the proxy (`GIT_SSH_COMMAND`), which would replace a person's own `core.sshCommand`
   and their hosts' `ProxyJump`; add a connect helper when someone needs SSH lent on a self-hosted server.
5. **The switch's words** say what goes through and what doesn't, on the web, the phone and the desktop app, in 14
   languages: on the Cloud "websites, git, SSH, databases and other TCP connections", never the person's own network
   or mail on port 25, while name lookups, calls and other UDP traffic keep the usual way; on a self-hosted server
   (`selfHosted`, the desktop app's server not the Cloud's) what follows proxy settings and what ignores them
   (`devices.shareInternetHintProxy`, `desktop.pair.internetHintProxy`). The once-only inbox notice no longer says
   "only websites".

Consequences: more of the agents' traffic crosses the server and the person's connection (still no byte cap); a
lending computer on an older app carries the web alone until it updates; lent traffic never touches a paid proxy:
the Cloud's guard goes the proxy way only for what the socket didn't carry (no lender, a refusal, a failure, port 25,
root's own traffic, UDP).

## Amendment 2026-11-27 c: AI calls go direct; "Use only this computer's internet"

Owner decision: by default the agents' AI traffic never goes through the person's computer. A lent hop adds latency to
every model call and gains nothing (providers don't block datacenters), and a key or a sign-in never depends on
someone's home connection. Under the switch, a nested choice, off by default, sends everything through it.

1. **One list.** `EGRESS_DIRECT_HOSTS` (`machine-protocol.ts`) names the model providers' and the AI CLIs' services
   (a leading dot: the name and every name under it); new ones are added there alone. A self-hosted borrower already
   put them in `NO_PROXY`. On the Cloud the workspace's computer's runner writes them next to its socket
   (`<runner home>/egress-relay.json`: `{ only, direct }`, `writeEgressPolicy`), and the guard keeps a TLS connection
   to port 443 whose server name matches one its usual way, without asking the socket (the Cloud's ADR 0009). The
   server's own model calls never went through a lent connection (§3 of the 2026-11-27 amendment).
2. **The choice.** "Use only this computer's internet" (`machines.egress_only`, migration 0367; `internetOnly` in
   `PATCH …/devices/computers/{id}`, `shareInternet.only` in the list) shows under the switch while it is on, on the
   web (`PrefRow` `nested`), the phone (`GroupedRow` `depth`) and the desktop app (`PrefRow` `nested`). Its owner
   turns it on (`device.share_owner_only`), only while it lends (`device.share_off`); an admin may turn it off;
   turning the switch off turns it off. An older server sends no `only`, and the apps show no such row.
3. **What it does.** While a computer in the workspace is lent "only", just such computers carry its connections
   (the pick ignores the others), and nothing goes the usual way: `EGRESS_DIRECT_HOSTS` go through it too (the guard's
   file says `direct: []`, a self-hosted borrower's `NO_PROXY` and Chrome's bypass list drop them and a Claude Code
   turn's endpoint), and the server's reads of web pages go through it on the Cloud too, with no fallback
   (`EgressFetch.lentFetch` `only`). Borrowers hear it in `welcome.egressOnly` and in `egress.only` when it changes
   (`EGRESS_ONLY_PROTOCOL`, 97; `tellBorrowersOnly`, not awaited by the change).
4. **Offline.** None of them online (or a dial that fails on one): the server closes the borrower's data socket
   `notFound` ("<name> is offline"), never `unreachable`, so no borrower goes its usual way. The runner's proxy and
   the Cloud's guard, told `only`, fail every other failure too, but the server's `unreachable`: that means no
   computer is lent "only" any more (it was turned off or removed while they missed the change), so the usual way.
   Port 25 then never goes out. Name lookups and other UDP keep their way (the guard drops QUIC while lending).
5. **Said.** A computer brain on a borrowing computer (`managed`, `host`) can't reach its AI then: `resolveBrain`
   answers `lent_offline` (`lentOnlyOffline`, read alongside its computer's status so no turn waits for it), and the
   run waits for that computer as for its own (`waitingMachineId` is the lent one, so its coming back resumes it),
   its note "I have no internet right now: <computer> is offline… I'll answer when it's back, or once “Use only this
   computer's internet” is off on its page" (`chat.body.brain_unavailable_lent_offline`). A model brain's page reads
   fail with `lentOfflineText`. The workspace's computer's page says "Agents have no internet: <name> is offline"
   (`egressOffline` in the machine view), on the web and the phone. 14 languages.

Consequences: AI calls from the workspace's computer stop crossing the server and a home connection by default; with
the choice on, the workspace's agents are offline whenever that computer is; a self-hosted borrower stays
cooperative (programs that ignore proxy settings still go out their own way, as before); a paused lending computer
reads online to `lentOnlyOffline` (the run's turn then fails on its own, as any CLI error).
