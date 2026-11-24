# 0217. Pictures from the web in a reply

- Status: Accepted
- Date: 2026-11-22
- Extends: ADR 0196 §8 (pictures from the web in a live file: the download guard), ADR 0197 (pictures an agent makes
  go on its reply as picture files), ADR 0117 (an address may not carry what the run read in private), ADR 0109 (the
  web's tools, every agent's)
- Code: `packages/engine/src/web-tools.ts` (`show_image`, `SHOW_IMAGE_TOOL`, `SHOW_IMAGE_LIMITS`), its place in the
  run policy (`tools/run-policy.ts`, `HERE`) and in the agent's access tree (`access.ts`), the line in "What you can
  do" (`capabilities.ts`); tests `packages/engine/test/show-image.test.ts`

## Context

An agent that has a picture's address (one a connected app listed, a product's photo, a cover it found) could only
paste the address, and the person had to open each link to see what the reply was about. A conversation draws pictures only as files (`meta.artifacts`): what a person attaches, what `generate_image` makes,
what an agent uploads from its computer. The message text has no picture syntax, and the server already downloads
pictures from the web safely, but only into live files.

Drawing a picture straight from the address an agent wrote was never an option: each reader's app would ask a site
the agent chose (their address and the time they read, to anyone), and an address is a way out for what a run read,
which is why every address a run asks for goes through the outbound check.

## Decision

1. **A tool, `show_image`.** `{ images: [{ url, title? }] }`, up to 6 a call and 10 a run. For each address: the
   outbound check (ADR 0117), then `fetchWebPicture` (https only, public addresses on every redirect, the socket
   pinned, 15 MB, pictures only by their bytes), then a picture file saved where the run posts (`createFileArtifact`,
   its first version's note saying the site it came from). The files go on the reply through `data.artifacts`, like
   the pictures `generate_image` makes, so every app draws them with the picture cards it already has. An SVG is
   shown as the PNG drawn from what the sanitizer rebuilt, or not at all.
2. **Every agent's, in every run.** No scope, like the web's other tools, in the same source; offered only where the
   source can save files. It is a core tool (always listed): the moment to use it is in the middle of an ordinary
   answer, where a group loaded on demand would be skipped. "What you can do" says when (a picture it is talking
   about) and that Markdown's image syntax isn't drawn.
3. **It speaks here.** In the run policy it is a `here` tool: a person's run shows pictures in its conversation; a
   routine's run, which speaks only through its report, doesn't. A confidential thread refuses it, like the web's
   reads: an address leaves the server.
4. **What fails is said.** A page instead of a picture, a site that refuses, an address past the limits: the answer
   lists each with why, and the agent gives those as links. The others are still shown.

## Consequences

- A picture shown is a copy in the workspace's storage: it stays when the site takes it down, and counts in the
  Drive like any file of the conversation.
- The apps still never load anything from an address in a message.
- The tool's definition is in every run's tool list (about 200 tokens).
