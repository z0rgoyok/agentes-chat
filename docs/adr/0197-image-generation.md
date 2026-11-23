# 0197. Image generation through the Model Gateway

- Status: Accepted
- Date: 2026-11-17
- Amends: 0012 (a usage kind `image`), 0018 (providers: images beside text)
- Code: `packages/providers/src/images.ts` (`IMAGE_CATALOG`, `ImageRequest`, `ImageResult`, costs) and each adapter's
  `generateImage` (`openai.ts`, `gemini.ts`, `openrouter.ts`, `custom.ts`, the fake in `fake.ts`), engine
  `gateway.ts` (`generateImages`), `packages/engine/src/live/images.ts` (requests on a canvas, the `live.image` job,
  placement; `generateInChat` for pictures in a conversation), the `generate_image` tool, routes
  `apps/server/src/routes/app/images.ts`; migration adding `usage_kind` `image`

## Context

People ask agents for images all the time, and the only images made today come from Codex's own tool on a
computer, billed to a ChatGPT plan and invisible to the workspace's budget. A canvas that groups generated images
(ADR 0196) needs images made on request, by any agent from a conversation (a person asks it there), priced
and limited like every other model call.

## Decision

**One catalog of image models, apart from the chat models.** `IMAGE_CATALOG` lists each model with its provider,
the sizes and aspect ratios it takes, how many images one call returns, whether it takes reference images (edits,
variations) and its price, per image or per token as its maker bills it, checked against each maker's price page.
It never enters `MODEL_CATALOG`, so image models never show up in model pickers, the router or Automático.

- Google Gemini (Nano Banana 2.1, Nano Banana 2, Nano Banana Pro, Nano Banana 2 Lite) through the Interactions API
  the Gemini adapter already speaks, with an image `response_format` and reference images as inline parts.
- OpenAI's GPT Image models through `/v1/images/generations` and `/v1/images/edits`.
- OpenRouter's image models through `/api/v1/images`, which report their own cost.
- A workspace's own OpenAI-compatible endpoint (ADR 0146) when it serves `/images/generations`, priced by the
  workspace (zero by default), which is how a self-hosted server uses a local image model.

A workspace can generate images when it has a key (its own, or the platform's) for one of those providers. Which
models each workspace may pick is `GET …/images/models`; the default is the first one available in that order.

**Every image goes through the gateway.** `generateImages` mirrors `stream`: the workspace's standing, the agent's
budget reserved at the model's worst case before the call (or the person's own limit, ADR 0141, when a person tries
a failed request again), the key resolved for the image model's provider (never an agent's chat credential of another
provider), the call, and one `usage_records` row of the new kind `image` with the cost the provider reported or the
catalog's, the run, the agent or the person. Readers of "what an agent's budget paid" count `agent` and `image`.
A failed call is settled at what the provider billed, usually nothing.

**Images land where they were asked for.**

- *In a conversation*, an agent posts them in it: each image is a picture file (a `file` artifact of its image type,
  in the Drive where the run posts, ADR 0019) on the agent's reply, so people see the pictures in the chat like any
  picture someone posted, with that conversation's audience. They are made through the gateway while the agent
  waits (a provider that is down or limiting gets one more try), and handed back to the model to look at. Asked
  for "a canvas with the third one", the agent makes it with `create_canvas` and that file, whose bytes are copied
  into the canvas (ADR 0196 §8). No canvas is made behind people's backs.
- *On a canvas* (the one named; in a canvas's own conversation, ADR 0199, that canvas by default), the request
  first places a frame titled with the prompt and one placeholder per image, so everyone in it sees what is coming
  and who asked; a job (`live.image`, ADR 0005) calls the gateway, stores each image as an asset of the canvas
  (ADR 0196 §8) and turns each placeholder into the image, with its prompt, model, who asked and the images it
  started from. A failure leaves the placeholder saying why, with Try again.

Variations and edits send the images to start from as references: on a canvas its pictures, in a conversation
picture files the agent reads (a picture posted there).

**People and agents.** People ask an agent: in the canvas's own conversation (Variations, ADR 0199) or any other.
On the canvas a person only tries a failed request again (Try again on its placeholder: a person who may upload
files, at most 30 an hour). Agents call `generate_image` (`drive:write`), which waits for the images (at most two
minutes), hands them to a model that can see them, and answers with the pictures as the reply's cards
(`meta.artifacts`, one per picture) or, on a canvas, the canvas as the reply's card. In Codex's turns both tools
exist; the prompt says ours posts the images in the conversation (or on a canvas) and counts them in the budget.

*Amended 2026-11-17.* Generating is one of three ways an agent puts a picture in a live file (ADR 0196 §8): it writes
an SVG for icons, logos, diagrams and simple illustrations, places a picture from the web (`image_search`) when
someone asks for a real photo or a specific existing image, and generates new artwork or photos here. An SVG on a
canvas used as a reference is sent to the image AI as a PNG when the server can draw one, and left out otherwise:
image AIs take only raster pictures.

## Consequences

- Image spend shows in Usage with its own kind, and budgets stop it like any other spend.
- Prices change often: they are dated in the catalog like text models' (ADR 0018), each call priced at its time.
- A workspace with only an Anthropic key can't generate images: its agents aren't offered `generate_image`, and
  they put pictures in with an SVG or from the web instead.
- Pictures made in a conversation are Drive files like an upload: counted in the workspace's storage, seen by who
  sees the conversation, and one call away from a canvas.

*Amended 2026-11-18.* The canvas's own "Generate image" panel (a prompt, a model, a shape, a count) is gone, with
the route that made pictures for a person directly: pictures are asked for in a conversation, where the agent can
also write an SVG or find a real photo when that fits better.
