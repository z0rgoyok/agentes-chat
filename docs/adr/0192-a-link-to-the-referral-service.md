# 0192. A link to the referral service

- Status: Accepted
- Date: 2026-11-17
- Extends: ADR 0002 (the core knows no plans), ADR 0079 (§3, the signed link to the billing service)
- Code: `packages/engine/src/referrals-link.ts`, `packages/engine/src/billing-link.ts` (`sealLinkToken`, `linkReturnPath`, `linkUrl`), `apps/server/src/routes/app/referrals.ts`, `apps/server/src/routes/app/account.ts` (`referralsUrl`), `packages/config/src/schema.ts` (`REFERRALS_URL`, `REFERRALS_LINK_SECRET`), `packages/config/src/index.ts` (`referralsLinkSecret`), `apps/web/src/components/Sidebar.tsx` (`AccountMenu`), `apps/web/src/routes/refer.tsx`, `apps/mobile/src/features/me/MeScreen.tsx`

## Context

Whoever runs an instance may run a referral program: people bring others in and get something for it. A program has rates, codes, payouts and fraud rules, and none of that belongs in the server process (ADR 0002): a self-hosted server has no program, and a program's rules change without a release. What the program needs from the server is only a way in that proves who is asking, the same need the billing service has (ADR 0079 §3).

## Decision

### 1. Off unless configured

- `REFERRALS_URL`, an https address, turns it on. The link is signed with `REFERRALS_LINK_SECRET` (at least 32 characters), which the referral service shares with this server; unset, with `BILLING_LINK_SECRET`, shared with the billing service too. So a server with a referral service and no billing service sets its own secret, and the server refuses to start with the address and neither secret.
- Without it, `GET /api/app/auth-config` says `referralsUrl: null`, `POST /api/app/referrals-link` answers 404 `referrals.off`, and no app shows anything.

### 2. The link

- `POST /api/app/referrals-link` with `{ returnTo? }` answers `{ url, expiresAt }` for any signed-in person, with or without a workspace: the link is the person's own, not a workspace's, so it needs no permission. 30 links an hour per person (`rate_limited`, 429).
- The URL is `REFERRALS_URL/link?t=<token>` (a path in `REFERRALS_URL` is kept, with no doubled slash). The token has the billing link's format (ADR 0079 §3): `"v2." + nonce + "." + ciphertext + "." + tag`, the claims as UTF-8 JSON sealed with AES-256-GCM under a key HKDF derives from that secret. *Amended 2026-11-24:* it was `v1`, the claims readable in the address under an HMAC-SHA256 signature; the referral service takes both until no server minting `v1` is left (deploy it first).
- The claims: `aud: "agentes-referrals"`, a random `jti`, `iat` and `exp` (seconds, `exp = iat + 300`), the person's `userId`, `email`, `name` and `locale` (their language, as the billing link takes it), `orgs` and `return`.
- `orgs`: the workspaces the person is in, at most 50, oldest first, `{ id, name, role }`. A blocked account has none, and a workspace being deleted or suspended is left out (the billing link refuses a suspended one too); one on hold stays, since paying is how a billing hold ends. `role` is `owner` for an owner, `admin` for a member who may manage billing (as the billing link decides it), else `member`.
- `return`: the path in this app the service sends the person back to. `returnTo` when it is a workspace's path in the shape the billing service accepts (`/org/<uuid>` plus lowercase letters, digits, `-` and `/`, its search and hash dropped), else `/`.
- The web app mints the link on the click and only ever navigates to it, as it does the billing link.

### 3. What the referral service must check

- The seal, with a 16-byte tag, before it parses anything (`v1`: the HMAC over the payload exactly as received, in constant time).
- `aud` is `agentes-referrals`: a billing link, signed with the same secret, is refused.
- `iat` and `exp` with 30 seconds of clock skew, and a link whose `exp - iat` is over 10 minutes is refused.
- Each `jti` once.
- `return` only in the shape above, on this server; anything else refuses the whole link.

### 4. Where people find it

- Web: "Refer and earn" in the person's own menu, right under Settings, where `referralsUrl` is set. `/refer` mints the link and leaves at once, replacing its own entry in the history so Back from the referral service goes to the page before it (not to `/refer`, which would mint a link and leave again), showing the app's start splash meanwhile; signed out, it goes through sign-in and back; off or failing, it shows the page that doesn't exist, with its way back. Other sites link to `/refer`. The referral service sends a person who opens one of its pages with no session there (a bookmark, Back, a session past its end) to `/refer` too, and lands them on the page they asked for.
- Phone: the same row in Você's preferences, opened in the in-app browser.

## Consequences

- A self-hosted server changes nothing: without `REFERRALS_URL` there is no route, no row and no word of it.
- The server knows nothing of the program: no rates, codes or money, and nothing comes back from the referral service.
- The link is a credential for five minutes, minted only on a click or a visit to `/refer`, carried only in the address bar, and used once by the referral service.
- Without `REFERRALS_LINK_SECRET`, one secret seals both links; `aud` keeps them apart, and both services check it: the referral service refuses `agentes-billing` (§3) and the billing service refuses anything but its own `agentes-billing` (ADR 0079 §3). Rotating it means setting the new value on this server, the billing service and the referral service together; with its own secret, on this server and the referral service. Links minted just before fail once and are minted again.
