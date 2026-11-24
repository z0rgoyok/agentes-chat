# 0216. A connector before the browser

- Status: Accepted
- Date: 2026-11-21
- Extends: ADR 0043 (tools on demand, `find_tools` names missing connectors), ADR 0061 (cards that open the app's own
  dialogs: `offer_connect_app`)
- Code: `packages/engine/src/connectors/sites.ts` (`CONNECTOR_SITES`, `CONNECTOR_NAMES`, `connectorsForUrl`),
  `packages/engine/src/tools/connector-first.ts` (`browserFirst`, `browserOpens`), the gateway's call of it
  (`tools/gateway.ts`, beside `connectorFirst`), the names in `connectorStates` (`connectors/listing.ts`) and
  `catalogConnector` (`setup-tools.ts`); tests `packages/engine/test/connector-first.test.ts`

## Context

People ask an agent to "log in to my Meta Business" or "post this on X" and the agent opens the site in its browser,
even where the workspace could connect the service in one click and the agent would then act through its API: no
sign-in typed in the agent's browser, no captcha, no page that changes under it. Many people don't know the connector
exists. `connectorFirst` already turns a `request_secret` for a service we connect into the way in; nothing did the
same for the browser, and the catalog only knew a service by its label and id ("Facebook Ads" found nothing).

## Decision

1. **The sites and other names of a service.** `CONNECTOR_SITES` lists, by connector id, the pages people use the
   service on (a host, with `www.`, with an optional path, or a leading dot for any host of a domain:
   `.atlassian.net`). `CONNECTOR_NAMES` adds the names people call it by ("Meta Business Suite", "Facebook Ads" and
   "Ads Manager" for Meta Ads). The names join the label and ids in `connectorStates` (so `find_tools` and
   `connectorFirst` know them) and in `catalogConnector` (so `offer_connect_app` takes them).
2. **The first open suggests, once per conversation.** When a browser call (`browser_open`, a `browser_do`'s `open`
   step, a new tab) opens a page of a service this server can connect (not `soon` or `unavailable`), and this agent
   hasn't heard of it in this conversation in the last 7 days, the gateway opens nothing and answers with the way in,
   by how the agent stands with the service (`wayIn`, as for a key): its tools when it has them, `request_permission`
   when the workspace has it, `offer_connect_app` (the existing "Conectar …" card, web and phone, which shows who may
   connect it) when it isn't connected. The agent suggests it in one line and lets the person choose.
3. **Never a refusal.** The answer's code (`browser.connector_first`, with the connectors) is kept on the run's step;
   the next open of that service's pages in the conversation finds it and opens. A person who says to go ahead in the
   browser gets the browser; a run nobody reads (a routine) opens it on its second try.

## Consequences

- One extra tool call the first time an agent reaches for a service's site in a conversation.
- A new connector gets its sites and names in `sites.ts`; a test checks every id there is one the catalog has.
