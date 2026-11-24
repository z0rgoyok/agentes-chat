# agentes.chat on Coolify

The app and Postgres with pgvector, as one Coolify resource. Coolify supplies the domain and
every secret; nothing in this folder names a host or holds a value.

```
docker-compose.yaml   the stack: agentes + postgres, and the metadata a Coolify template needs
```

Settings are not duplicated here: every one the app reads is listed, annotated, in the
repository's [`.env.example`](../../.env.example).

Everything the app does, and everything else about self-hosting it, is in
[`SELF_HOSTING.md`](../../SELF_HOSTING.md).

These steps were run once, end to end, on Coolify 4.7.5 with Traefik 3.7: a Docker Compose
application from this repository, the `sslip.io` address it generates, then the move to a real
domain — certificate issued, `PUBLIC_URL` following the domain, both containers healthy.

## Requirements

- Coolify v4, current release, on a Linux server.
- 2 vCPU, 4 GB RAM and 20 GB disk to start (the image is about 2 GB, and the database and the
  files volume grow with use). 8 GB if agents will run commands and a browser on this machine.
  On a 4 GB host set `AGENTES_MEMORY=3g` (below) so the app's cap still protects Postgres.
- A domain you can point at the server, for HTTPS. Coolify's generated `sslip.io` address is
  `http://` only: Let's Encrypt rate-limits the shared `sslip.io` zone, so it cannot get a
  certificate.
- Outbound HTTPS to the model providers your organizations use.

## 1. Create the resource

1. **New resource → Application → Public repository**, with this repository's URL.
2. **Build pack: `Docker Compose`**.
3. **Base Directory: `/deploy/coolify`**, **Docker compose location: `/docker-compose.yaml`**.
   Without the base directory Coolify finds the repository's own `docker-compose.yml`, which
   expects the interactive setup and its `.env`.
4. Branch: the one you deploy from. Leave **Auto deploy** off unless you want a push to this
   repository to redeploy.

## 2. The variables Coolify generates

On the first save, **Environment Variables** lists the ones this file leaves open. Do not edit
them by hand:

| Variable | What it is |
| --- | --- |
| `SERVICE_URL_AGENTES_3000` | The app's domain, routed to port 3000. Managed from **Domains**. |
| `PUBLIC_URL` | That address without the port. The exact address people open: sign-in, the only browser origin allowed to change anything, and every link the app sends. |
| `AGENTES_SECRET` | Signs sessions and encrypts every key an organization stores (model providers, connectors, mailboxes, databases). Never change it on a running instance. |
| `SERVICE_PASSWORD_POSTGRES` | The database password, used only inside `DATABASE_URL`. |
| `AGENTES_IMAGE` | The image to run. Defaults to `ghcr.io/agentes-chat/agentes:latest`; a version tag or a digest holds a version. |
| `AGENTES_MEMORY` | The cap on the app's memory, swap included. Defaults to `8g`. The app brakes below it: past 70% its job slots stop growing, past 85% it sheds long jobs. |

Coolify writes the resource's variables into `.env` in the deployment directory and passes that
file to every container, so anything you add under Environment Variables reaches the app without
editing `docker-compose.yaml`.

## 3. First deploy

Deploy. Coolify generates a `sslip.io` domain from the server's IP and routes it to the app.

Check that the app is up:

```sh
curl -fsS http://<the generated address>/api/health
```

It answers `{"status":"ok",...}`. That is all this address is good for: it is plain HTTP, so
sign-in, cookies and the apps need the real domain. Do not create the owner account here.

The first boot runs the database migrations. While that happens the app answers 503 and the
healthcheck reports `starting`; it settles after a minute or two on a fresh volume.

## 4. Your own domain

1. **Domains** → add `https://chat.example.com`, port 3000, save.
2. Point the domain's DNS record (an `A` record) at the server. Wait for it to resolve.
3. **Delete the generated `sslip.io` domain.** Keep one domain per resource: `PUBLIC_URL` is
   derived from the service's domain, and which one wins with two is not documented.
4. **Redeploy.** Coolify requests the certificate, and the app restarts with the new
   `PUBLIC_URL`. Until it does, the new domain answers "Invalid origin" on sign-in.

Confirm what the app sees:

```sh
docker exec $(docker ps --format '{{.Names}}' | grep agentes | head -1) printenv PUBLIC_URL
```

It must print `https://chat.example.com`, exactly as people type it: no trailing slash, no port.

## 5. The first account owns the instance

Sign-up is closed by default (`ALLOW_SIGNUP=false`), with one exception: while no account
exists, the first one to sign up becomes the owner. Open your domain and create it now; after
that, people join by invitation from **Settings → Members and invitations**.

If the instance will be reachable before you can get to it, or you want to be the only one who
can claim it, set `OWNER_CLAIM_SHA256` before the first deploy:

```sh
openssl rand -hex 32 > owner-token.txt          # keep this file
openssl dgst -sha256 -r owner-token.txt          # the first field is the value to paste
```

Add `OWNER_CLAIM_SHA256=<that value>` under Environment Variables and redeploy. Only the link
`https://chat.example.com/owner#claim=<the token from owner-token.txt>` creates the first
account. Then delete the variable.

Model keys are not here: each organization adds its own under **Settings → AI and usage**.

## 6. Verify

- `curl -fsS https://chat.example.com/api/health` answers `{"status":"ok"}`.
- Sign in, and a second message in a channel arrives without reloading (WebSockets).
- Send a small file in a chat and open **Drive**: uploaded files land on the `files` volume.
- Create an agent with the organization's model key; it answers in a channel.
- Both containers are healthy: `docker ps` shows `postgres` and `agentes` as `healthy`.

## 7. Configure

Every setting the app reads is in the repository's
[`.env.example`](../../.env.example): what it does, its default, and how to turn it on. Coolify
writes the resource's variables into `.env` and passes that file to every container, so a setting
reaches the app without editing `docker-compose.yaml` — paste `KEY=value` under **Environment
Variables** (the bulk editor takes plain lines), save, redeploy.

Four settings in that file belong to Coolify, and pasting them empty breaks the instance:
`PUBLIC_URL`, `DATABASE_URL`, `AGENTES_SECRET` and `FILES_DIR` (all four are in §2).

The ones most instances change: `SMTP_URL` or `MILLIONSEND_API_KEY` (invitations, password
resets and budget alerts; without them those emails go to the container log instead),
`GOOGLE_CLIENT_ID`/`GITHUB_CLIENT_ID` (sign-in), `SOURCE_URL` (where the About screen points
for this instance's source, AGPL-3.0 §13 — set it if you run a modified version), `S3_*` (files
in a bucket instead of the volume), `LOG_LEVEL`.

Two defaults send data to the project that makes agentes.chat:

- `TELEMETRY=on` posts one anonymous usage report a day to `https://telemetry.agentes.chat`
  (counts, sizes, tokens used; never messages, files, names or sites).
- `FEEDBACK_RELAY=true` sends what someone types into the feedback form, when they press send.

`TELEMETRY=off` and `FEEDBACK_RELAY=false` stop both. `docker compose run --rm agentes
telemetry` prints exactly what the report would contain.

## 8. Upgrade

Change `AGENTES_IMAGE` to a version tag (`ghcr.io/agentes-chat/agentes:1.4.0`) or leave it on
`latest` and redeploy. Migrations run on boot; no separate step.

Coolify's **Rollback** page deploys older images of applications it built itself, which is not
this resource. To go back, set `AGENTES_IMAGE` to the previous tag and redeploy — and note that
migrations do not reverse. Keep the previous tag next to your backups.

After an upgrade, `bun run docs:env` regenerates `.env.example`: read it again for the settings a
new version adds.

A redeploy imports the branch at the new commit and parses `docker-compose.yaml` again, so a
change to the stack itself — a new `image`, `command`, `healthcheck`, or service in the file —
takes effect without any step here. Two things it cannot do for you:

- **A new setting with no default** (`${SOME_VAR:?}` in the file) fails the deploy until you add
  it in **Environment Variables**. Migrations running on boot also never touch values stored in
  Coolify, such as `POSTGRES_PASSWORD`.
- **A Postgres major-version bump** (pg18 to pg19) does not start on the existing data volume.
  Dump the database, deploy, restore into the empty volume — §9.

Point the application at the upstream repository once this file is merged there; until then it is
the fork's branch.

## 9. Backup and restore

Everything lives in three places, and a backup of one alone is not a backup:

```sh
# 1. the database
docker exec $(docker ps --format '{{.Names}}' | grep postgres | head -1) \
  pg_dump -U agentes -d agentes -Fc > agentes-$(date +%F).dump

# 2. the uploaded files (find the volume with: docker volume ls | grep files)
docker run --rm -v <project>_files:/data -v "$PWD":/backup alpine \
  tar czf /backup/files-$(date +%F).tgz -C /data .

# 3. AGENTES_SECRET, from Environment Variables in Coolify, in a password manager
```

Without `AGENTES_SECRET`, a restored database has every organization's stored keys unreadable.
Restore with the app stopped: `pg_restore -U agentes -d agentes --clean --if-exists`, unpack the
files volume, set the same `AGENTES_SECRET`, deploy.

Coolify's own scheduled backup works on databases it manages itself; the Postgres here is part
of this resource, so it is not in that list. Run the commands above from a cron job or Coolify's
Scheduled Tasks.

## 10. Troubleshooting

| What you see | What happened | What to do |
| --- | --- | --- |
| Sign-in: "Invalid origin"; saving: `bad_origin` | `PUBLIC_URL` is not the address you opened. | `printenv PUBLIC_URL` in the app container; fix **Domains**, redeploy, keep one domain. |
| 502 or 503 from the proxy | First boot is migrating, or the app crashed at boot on a config value. | Wait two minutes; then **Runtime Logs**. A config error names the variable. |
| Migration fails: `type "vector" does not exist` | `DATABASE_URL` points at a Coolify "PostgreSQL" database resource, whose image has no pgvector. | Use the `postgres` service of this file. Moving data means a dump and a restore. |
| Invitations or password resets never arrive | No `SMTP_URL` or `MILLIONSEND_API_KEY`. | Set one; until then the email is in the log, on purpose. |
| Container restarts under load | `AGENTES_MEMORY` is at or above the host's RAM. | Lower it (`3g` on a 4 GB host). |
| `/mcp` fails from claude.ai or ChatGPT, or `.well-known/oauth-*` 403s | A CDN in front is challenging bot-like paths. | Skip challenges and rate limits on `/mcp`, `/.well-known/*` and `/api/oauth/*`. |
| Uploads over ~100 MB fail | A proxy in front has a body limit. | Coolify's Traefik has none; Cloudflare free has 100 MB. |
| WebSockets drop every minute | A proxy in front is timing out idle sockets. | Read timeout of 60 s or more; the app pings every 30 s. |

## 11. Optional services

The repository's `docker-compose.yml` also carries a local speech server, local embeddings and
an S3 backup service, each behind a compose profile. To add one here, copy that service and its
network from there into this file and set what its comments name (`LOCAL_SPEECH_URL`,
`EMBEDDINGS_PROVIDER`/`EMBEDDINGS_URL`, `S3_*`). None of them is required to run the app.

## 12. What needs a public URL

The instance is meant to be reachable on the internet at your domain. A few things call it from
outside and do not work otherwise: routines started by GitHub, Sentry or their own webhooks
(`/api/webhooks/…`, `/api/hooks/…`), a GitHub App's events
(`/api/github-app/webhook`), Composio's events, and AI apps that call `/mcp` from their own
servers (claude.ai, ChatGPT). Claude Code, Cursor and VS Code call from your computer, so they
also work on a private instance.

## 13. One-click template (a suggestion, not this flow)

The metadata at the top of `docker-compose.yaml` (`documentation`, `slogan`, `category`, `tags`,
`logo`, `port`) is what Coolify's catalog reads, so this same file can also ship as a template:
copy it into `coollabsio/coolify` as `templates/compose/agenteschat.yaml`, add the logo, and a
page in `coollabsio/coolify-docs`. Whether to publish that is the Coolify maintainers' call.

The two flows differ only in how the resource is created, not in what runs — the same compose,
the same two containers:

| | from this repository (above) | as a catalog template |
| --- | --- | --- |
| updates | git: the file is read again at each deploy | the compose is stored in the resource; change `AGENTES_IMAGE` or paste the file |
| `postgres` | a container of this resource | the same container, plus a database page and scheduled backups |
| backup | §9 commands on a schedule | the database page |

A template is one compose, so it cannot create a second resource (a database of its own) or
schedule a backup; those stay with whoever installs it.
