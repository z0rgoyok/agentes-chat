# 0193. A workspace's accent color, and its look set from the operator API

- Status: Accepted
- Date: 2026-11-17
- Extends: the design system's tokens (`docs/design/design-system/tokens.css`), the workspace logo, ADR 0056 (the
  operator API)
- Code: palette `packages/tokens/src/accent.ts` (`accentPalette`), re-exported by `@agenteschat/ui`; schema
  `packages/db/src/schema/tenancy.ts` (`organizations.accent`, migration 0287); engine `packages/engine/src/avatars.ts`
  (`setOrgAccent`, `setOrgLogo`, `removeOrgLogo`); routes `apps/server/src/routes/app/account.ts`
  (`PUT …/organizations/{orgId}/accent`), `apps/server/src/operator/orgs.ts` (`PUT /orgs/{orgId}/look`); client
  `packages/client/src/api/queries.ts` (`useSetOrgAccent`), `realtime/machines.ts` (`org.look`); web
  `apps/web/src/lib/theme.tsx` (`useWorkspaceAccent`), `components/WorkspaceAccent.tsx`; phone
  `apps/mobile/src/ui/palette.ts` (`withAccent`), `ui/theme.tsx` (`AccentProvider`),
  `features/settings/AccentRow.tsx`; tests `packages/tokens/test/accent.test.ts`, `apps/server/test/org-logo.test.ts`,
  `apps/server/test/operator.test.ts`, `apps/web/test/workspace-accent.test.tsx`, `apps/mobile/test/accent-colors.test.ts`

## Context

A workspace already shows its own logo. Teams also want their apps in their own color, and a hosted service that runs
several workspaces for one company wants to give them all one look without asking each workspace's admins to set it
by hand.

## Decision

1. **The accent is the agent color family.** The design system has one color with a meaning, the agent color
   (`--agent`, `--agent2`, `--agent-soft`, `--on-agent`): agents' frames, mentions, links, focus and selected states.
   A workspace's accent replaces those four tokens and the default agent color they stand for (§5), nothing else. A
   second brand color beside it would need its
   own place on every screen and would compete with the agents' color; ink, surfaces, amber ("waits on you") and the
   danger and success colors keep their meanings in every workspace.
2. **Stored once, derived everywhere.** `organizations.accent` holds a lower-case `#rrggbb`, null for the default.
   The apps derive the four tokens for each theme with one pure function, `accentPalette(hex)` in
   `@agenteschat/tokens`, which the web and the phone share:
   - `agent` is the picked color moved in HSL lightness only, as little as needed (darker in the light theme, lighter
     in the dark one), until it reaches 4.5:1 on the theme's page background and on `agentSoft`, and one of the two
     default on-colors reaches 4.5:1 on it;
   - `agent2` is the lighter step of the default palette, the same hue a fixed share of the way toward white;
   - `agentSoft` is the default palette's quiet surface (lightness 94% light, 16% dark) in the color's hue, its
     saturation capped as the default's is;
   - `onAgent` is the theme's default on-color (white in light, the deep navy in dark) when it reaches 4.5:1, else the
     other one.
   The design system's own blue gives back the default tokens exactly, so a workspace that picks it looks as one
   with none. Grays, near-white, near-black, pure yellow and pure red all come out readable (tests assert the ratios).
3. **Who sets it.** In the app, whoever may `configure` the workspace, as for the logo:
   `PUT /api/app/organizations/{orgId}/accent` with `{ accent: "#rrggbb" | null }`. Settings › Workspace shows it beside
   the logo: the color now, the kit's picker with the agent presets as suggestions (the default blue first), a mention
   and a link painted in it before saving, and "Use the default". The phone has the same row. Each change is audited
   (`organization.accent_changed`, with `from` and `to`) and announced to the workspace (`org.look`, as the logo now
   is too), so every open app repaints without a reload. `accent` rides wherever `logo` does: `GET /me` and
   `GET …/organizations/{orgId}`. Changes are limited to 20 an hour per workspace (429 `rate_limited`), as each one makes
   every member's open apps fetch again; the operator's route (§6) is not limited.
4. **Where it shows.** The web sets the four custom properties for the current theme on `<html>` while the workspace
   shell is mounted, so dialogs and menus portaled out of the shell carry them too, and takes them away when the shell
   goes; pages outside a workspace (sign-in, onboarding, the account's pages) keep the design system's blue. The
   desktop app shows the web. The phone swaps the agent colors of its palette under the active workspace.
5. **The accent is the workspace's default agent color.** An agent with no color of its own paints with the named
   color `sky`, and so does the sky art (the sidebar's sky, a channel's sky band, an approval card's band, the logo
   mark). Inside a workspace with an accent, the agents' engine resolves `sky` to the accent (`setSkyColors` in
   `packages/ui/src/agent/engine.js`, the one place every drawing reads a named color through, `gradientOf`), so those
   agents' tiles, frames, mention chips, pixel faces and portraits and the sky art take the workspace's color. An agent
   given its own color keeps it. The pair handed to the engine is `accentSky(hex)`: the light theme's `agent2` and
   `agent` in both themes, as the landing's sky is one pair in both, so the agents' white eyes and text keep 4.5:1 on
   it whatever was picked (mention chips work out their own contrast per theme, as for any agent color). The web's
   shell sets it before its children render and clears it when it goes, with `data-accent` on `<html>`, which every
   drawing that repaints on a theme switch also watches (`PAINT_ATTRS` in `packages/ui/src/theme.ts`); the drawings'
   caches and memos are keyed by the colors `sky` resolves to (`drawnKey`). The phone's `AccentProvider` does the same
   (`paintSky` in `apps/mobile/src/ui/palette.ts`). As the engine's `sky` is the active workspace's, a list of several
   workspaces (the workspace menu, the phone's workspaces) draws each one's mark from its own accent, or the default
   blue (`workspaceSky` in `packages/ui/src/sky/accent.ts`).
6. **The operator may set a workspace's look.** `PUT /api/operator/v1/orgs/{orgId}/look` with
   `{ accent?, logo?: { contentType, base64 } | null }`: an absent field is left alone, null clears it. It goes through
   the same setters as the app with the system as the actor: the logo's type, size and metadata checks, the same
   storage, the same audit entries and the same `org.look` announcement. A hosted service can then give several
   workspaces one look; the workspace's admins can still change it afterwards. A self-hosted server without
   `OPERATOR_API_TOKEN` exposes nothing new.

## Consequences

- A workspace with no accent looks exactly as before; nothing changes for self-hosters who never pick one.
- Agents' own colors win: an agent given a color keeps it in every workspace; only the ones without a color, and the
  sky art, follow the accent.
- With a near-black accent in the dark theme, the agents' bodies sit close to the page's own dark: their eyes and the
  lighter dither tones keep them visible, but the tile reads quieter than the default blue's.
- An accent picked on the phone shows on the web at once, and the other way around.

## Left out

- The product's name and logo on pages outside a workspace (sign-in, invitations, emails): they stay the product's.
  A server-wide brand would be a separate decision.
- A second accent, per-person accents, and changing any token other than the agent family.

## Alternatives considered

- Storing all eight derived values: the derivation would be frozen at the time of saving, and the web and the phone
  could disagree. One hex and one shared function keep every app on the same rule.
- Setting the variables on the shell's own element: dialogs and menus are portaled to `<body>` and would show the
  default blue inside a workspace painted in another color.
