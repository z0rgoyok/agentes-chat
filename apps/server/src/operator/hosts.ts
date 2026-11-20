import type { Config } from "@agenteschat/config";
import {
  ConflictError,
  deleteHost,
  HOSTS_MAX,
  type HostLook,
  listHosts,
  normalizeHost,
  putHost,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, json, noContent } from "../routes/app/context";
import { AccentColor } from "../routes/app/schemas";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

const HostParams = z.object({
  host: z
    .string()
    .max(260)
    .openapi({ param: { name: "host", in: "path" }, example: "app.northwind.example" }),
});

const Host = z
  .object({
    host: z.string().openapi({ description: "Lower case, no trailing dot.", example: "app.northwind.example" }),
    name: z.string(),
    accent: AccentColor.nullable(),
    logo: z.boolean().openapi({ description: "It has a logo." }),
    poweredBy: z.boolean().openapi({ description: "Its pages before sign-in end with the powered-by line." }),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .openapi("OperatorHost");

const HostLookBody = z
  .object({
    name: z.string().trim().min(1).max(60).openapi({ description: "Shown where the product's name stands." }),
    accent: AccentColor.nullable()
      .optional()
      .openapi({ description: "Its accent color; null: the default. Left out: left as it is (none on a new host)." }),
    logo: z
      .object({
        contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
        base64: z.string().min(1).max(3_000_000).openapi({ description: "The image's bytes in base64, up to 2 MB." }),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          "Its logo, checked by its bytes, metadata removed; shown at the sign-in page's lockup height. Null: the name alone. Left out: left as it is.",
      }),
    poweredBy: z.boolean().optional().openapi({
      description:
        "Its pages before sign-in end with a line linking to the software's site. Left out: left as it is (true on a new host).",
    }),
  })
  .openapi("OperatorHostLook");

const hostJson = (h: HostLook) => ({
  host: h.host,
  name: h.name,
  accent: h.accent,
  logo: h.logo !== null,
  poweredBy: h.poweredBy,
  createdAt: h.createdAt.toISOString(),
  updatedAt: h.updatedAt.toISOString(),
});

/** This server's own hosts, which never register: `PUBLIC_URL`'s and each of `EXTRA_TRUSTED_ORIGINS`. */
export const ownHosts = (config: Config) =>
  new Set(
    [config.PUBLIC_URL, ...(config.EXTRA_TRUSTED_ORIGINS ?? [])]
      .map((url) => normalizeHost(new URL(url).hostname))
      .filter((h): h is string => h !== null),
  );

/** Extra hostnames this server answers on, each with the look of its pages before sign-in (ADR 0194). */
export function registerOperatorHosts(api: OpenAPIHono, { db, config, blobs }: OperatorDeps) {
  const own = ownHosts(config);
  // Better Auth marks its cookies Secure from `PUBLIC_URL` (its baseURL), on every host alike.
  const https = new URL(config.PUBLIC_URL).protocol === "https:";
  const store = () => {
    if (!blobs) throw new Error("the operator API needs the platform's blob store for a host's logo");
    return { db, blobs };
  };

  api.openapi(
    createRoute({
      method: "get",
      path: "/hosts",
      tags,
      summary: "The extra hostnames this server answers on (ADR 0194)",
      responses: { 200: json(z.object({ hosts: z.array(Host) })), 401: errors[401] },
    }),
    async (c) => c.json({ hosts: (await listHosts(db)).map(hostJson) }, 200),
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/hosts/{host}",
      tags,
      summary: "Register a hostname, or replace its look (ADR 0194)",
      description: `On that host the pages before sign-in show its name, logo and accent, and sign-in is by email alone. Point the hostname at this server and serve a certificate for it first: the server only answers what reaches it. It runs no bot check, and nothing ties an account to a host, so any account's email lookup, password sign-in and reset can be asked there: what guards them is the limits per network, tighter on registered hosts (10 email lookups in 10 minutes and 5 sign-ups in 15 minutes per network, for all of them together), and the wrong passwords per account (10 in 15 minutes from one network, 50 from all), each counted in a server process's memory, so a restart starts them again (ADR 0075). Applies at once on this process and within 30 s on the others. Refusals: \`host.invalid\` (not a hostname: no scheme, port or path, at least one dot), \`host.own\` (\`PUBLIC_URL\`'s host or one of \`EXTRA_TRUSTED_ORIGINS\`), \`host.too_many\` (409, past ${HOSTS_MAX}), \`host.needs_https\` (409, \`PUBLIC_URL\` isn't https, so the session cookies a registered host sets would carry no Secure flag), and a logo's as for a workspace's (\`logo.type\`, \`logo.too_large\`, \`logo.not_base64\`, \`logo.empty\`).`,
      request: { params: HostParams, body: body(HostLookBody) },
      responses: { 200: json(Host), ...errors, 409: errorResponse("Too many hosts, or `PUBLIC_URL` isn't https") },
    }),
    async (c) => {
      if (!https) {
        throw new ConflictError(
          "PUBLIC_URL isn't https: session cookies on a registered host would carry no Secure flag. Serve PUBLIC_URL over https first.",
          "host.needs_https",
        );
      }
      const look = await putHost(store(), own, c.req.valid("param").host, c.req.valid("json"));
      return c.json(hostJson(look), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/hosts/{host}",
      tags,
      summary: "Stop treating a hostname as registered, and delete its logo (ADR 0194)",
      description:
        "Its origin is no longer trusted and its pages show the product's own look. Sessions people hold there are not ended: they stop being reachable there once its traffic stops reaching this server. 404 when it isn't registered.",
      request: { params: HostParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      if (!(await deleteHost(store(), c.req.valid("param").host))) {
        return apiError(c, 404, "not_found", "This host isn't registered");
      }
      return c.body(null, 204);
    },
  );
}
