# Deploying ARTEX on Railway

Runbook for the Railway service that runs this repo. It records every problem actually hit
while getting `lala` (project `radiant-wonder`) live, so the next deployment does not repeat
them.

Names used below are the real ones; replace them if the service is renamed.

| Thing | Value |
| --- | --- |
| Project | `radiant-wonder` |
| Service | `lala` (built from this repo, branch `main`, root `Dockerfile`) |
| Database | `Postgres` (Railway Postgres plugin) |
| Volume | `lala-volume` → `/app/data` |
| Public URL | https://lala-production-70e340c2.up.railway.app |
| Target port | `8787` |

---

## 1. What the service needs

Nothing optional here — miss one and the app either fails to build or crash-loops.

1. **Postgres.** ARTEX stores everything in PostgreSQL. It reads `ARTEX_PG_DSN`; without a
   database config it exits immediately with
   `open stores: no database config found`.
2. **Volume at `/app/data`.** Holds SQLite leftovers, `jwt.key` and task artifacts. Without a
   volume those are lost on every redeploy. Mount it on `/app/data` — note that the image no
   longer declares a Docker `VOLUME` (Railway rejects that instruction).
3. **Domain with target port `8787`.** The binary listens on `:8787` (and the traffic proxy
   on `8788`). A domain whose target port is unset returns **502 "Application failed to
   respond"**.
4. **An active LLM profile.** Not needed to boot, but chat answers
   `No LLM configured yet` until one exists and is activated.
5. **An admin password** set once through `/setup`.

## 2. First deployment

```bash
# one-time: CLI + login (browserless works on a headless box)
curl -fsSL https://railway.com/install.sh | bash    # installs ~/.railway/bin/railway
~/.railway/bin/railway login --browserless

railway link -p radiant-wonder -s lala

# 1) database
railway add -d postgres -s Postgres

# 2) wire it to the app with a reference, so the DSN never lands in a shell history
railway variable set -s lala 'ARTEX_PG_DSN=${{Postgres.DATABASE_URL}}'

# 3) volume + domain (dashboard: Service → Settings → Volumes / Networking)
#    volume mount path: /app/data
#    domain target port: 8787
railway domain update https://<service-domain> --port 8787

# 4) deploy: push to main and Railway builds the repo itself
git push origin main
railway deployment list          # BUILDING → SUCCESS
```

`railway variable set` triggers a redeploy on its own, so step 2 usually starts a build before
you get to step 4. That is fine — the build is idempotent.

## 3. The image

`Dockerfile` is deliberately a **multi-stage source build**:

| Stage | Base | What it does |
| --- | --- | --- |
| `web` | `node:22-bookworm-slim` | `npm ci` + `npm run build:static` (Next.js static export → `web/out`) |
| `build` | `golang:1.26-bookworm` | `go mod download`, then `go build -tags embedui` with `web/out` copied to `server/webui/dist` |
| runtime | `python:3.12-slim-bookworm` | recon tooling + Playwright + bbot, then `COPY --from=build /out/artex` |

Rules that keep it building:

- **Never reintroduce `VOLUME`.** Railway fails the build with
  `dockerfile invalid: docker VOLUME at Line N is not supported, use Railway Volumes`.
  Use a Railway Volume instead.
- **Never `COPY dist/<arch>/artex`.** `/dist/` is gitignored and only the release CI produces
  that binary, so a repo build fails on that line. The binary must come from the `build` stage.
- The base image tags `node:22-bookworm-slim` and `golang:1.26-bookworm` must exist on Docker Hub.
- Builds take **~12–15 minutes**. Almost all of it is the bbot layer
  (`bbot -y --install-all-deps` runs dozens of Ansible tasks); the frontend and Go stages are
  a couple of minutes together. A one-layer code change still rebuilds the slow layer, so do
  not expect 2-minute deploys.
- Next.js needs a few GB of RAM during the export. If a build dies with an OOM/no output,
  raise the service memory rather than trimming the frontend.

## 4. Configuration reference

| Variable | Required | Notes |
| --- | --- | --- |
| `ARTEX_PG_DSN` | yes | `${{Postgres.DATABASE_URL}}` (private network; no public proxy needed) |
| `PORT` | no | Not read — the app binds `:8787` via `CMD`. Set the domain target port instead. |
| `ARTEX_LLM_PROVIDER` | no | `anthropic` / `openai` / `openai-responses` / `ollama`. Only for the env-driven single-provider mode; LLM profiles in the UI are the normal path and take precedence. |
| `ARTEX_LLM_MODEL`, `ARTEX_LLM_BASE_URL`, `ARTEX_LLM_PROXY` | no | Same env mode as above. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | no | Only for the env mode. Prefer UI profiles. |

Secrets (`ARTEX_PG_DSN`, API keys) belong in the Railway dashboard → Variables, or in a
reference like `${{Postgres.DATABASE_URL}}`. Never in git, a shell argument that ends up in
history, or a chat message.

## 5. LLM keys (OpenRouter / Google AI Studio)

Open **System → LLM → Paste keys**. One paste accepts keys from both providers:

| Prefix | Provider | Base URL | Free default model |
| --- | --- | --- | --- |
| `sk-or-` | OpenRouter | `https://openrouter.ai/api/v1` | first free model from OpenRouter's public catalogue (price 0 **and** tool support, sorted by context) |
| `AIza` | Google AI Studio | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |

- Unrecognised keys are refused and listed in red — they are not saved.
- Each key becomes its own profile, numbered in paste order; the model box per provider is
  editable (the OpenRouter free catalogue is offered as suggestions).
- Paste order becomes failover priority (first key = tried first).
- If no profile is active, the first imported key is activated automatically.
- With more than one key the **LLM pool is switched on automatically**, so an exhausted,
  revoked or rate-limited key (`429`) hands the next request to the next profile. That
  failover comes from `llmpool` (circuit breaker: 1 min / 5 min / 30 min backoff) and needs
  no extra configuration.
- Google **`AQ.…` tokens are not AI Studio API keys** (they are CLI/session tokens). They
  fail with `HTTP 400 "Please pass a valid API key"`. Use the `AIza…` key from AI Studio.
- If a key tests as 400/403 although the key looks right, enable the *Generative Language
  API* for that key's project in the AI Studio console.

## 6. Admin password

- First run: no hash in `settings.auth.password_hash` → the UI sends you to `/setup` to
  create the password (username is fixed as `ARTEX`).
- Logged in: sidebar user menu → **Change password**.
- **Forgotten password** — there is no public reset button on purpose (an unauthenticated
  reset means anyone can take over the admin account). Reset at the database level instead:

```bash
# SSH into the running container (Railway → service → `railway ssh`)
railway link -p radiant-wonder -s lala
railway ssh            # interactive shell

# the image has no psql, but the bbot venv ships asyncpg and ARTEX_PG_DSN is already set
/opt/bbot/bin/python - <<'PY'
import asyncio, os, asyncpg
async def main():
    c = await asyncpg.connect(os.environ["ARTEX_PG_DSN"])
    await c.execute("DELETE FROM settings WHERE key = 'auth.password_hash'")
    await c.close()
asyncio.run(main())
PY
```

Then open `/setup` **immediately** and set a new password — until you do, the first visitor
can claim it. Verify with `curl https://<domain>/api/auth/status` → `{"initialized":false}`.

The repo's `reset-password.sh` does the same thing where `psql` is available (local/docker
deployments).

First `railway ssh` on a fresh machine needs a key: `ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519`,
`railway ssh keys add -k ~/.ssh/id_ed25519.pub`, and `ssh-keyscan -H ssh.railway.com >> ~/.ssh/known_hosts`.

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `dockerfile invalid: docker VOLUME at Line N is not supported` | `VOLUME` instruction in the Dockerfile | remove it, mount a Railway Volume |
| Build fails at `COPY dist/.../artex` / `lstat dist: no such file` | image expected a prebuilt binary | build from source in a stage (current Dockerfile) |
| Build runs 15 min then fails with no useful log | out of memory during Next export | raise service memory |
| **502** `Application failed to respond` | domain target port unset/wrong | `railway domain update <domain> --port 8787` |
| Crash loop: `open stores: no database config found` | no `ARTEX_PG_DSN` | add the Postgres service + reference variable |
| `No LLM configured yet: go to System → LLM Profiles` | no profile, or none active | add keys via **Paste keys**, or press **Set as active** |
| `[llm-test] … HTTP 400 "Please pass a valid API key"` | wrong key type (e.g. `AQ.…`) or API not enabled | use the `AIza…` key / enable the API |
| Chat fails, logs show `429` | key rate-limited / out of credit | expected: pool trips it and the next profile takes over; check **Pool settings** is on |
| Data gone after a redeploy | no volume, or wrong mount path | volume must mount `/app/data` |
| `railway` can't find the service | CLI link is stale after adding a service | `railway link -p radiant-wonder -s lala` |

## 8. Post-deploy checklist

```bash
railway link -p radiant-wonder -s lala
railway deployment list                       # newest deployment = SUCCESS
railway logs -d --lines 30                    # ... backend listening on :8787 (data=/app/data, workers=3)
railway logs -d --lines 30 | grep -i "LLM configured from DB"
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/          # 200
curl -s https://<domain>/api/auth/status                            # {"initialized":true}
railway volume list                           # lala-volume → /app/data, Ready
railway domain                                # Target port: 8787
```

Then in the UI: log in, open **System → LLM**, confirm one profile is starred (active) and
**Test connection** succeeds, and run one small task.

## 9. Do not

- Do not commit keys, DSNs or `.env` files. The repo ships `.env.example` for shape only.
- Do not add an unauthenticated password-reset endpoint or button.
- Do not paste live keys into chat/issue trackers — treat them as leaked and rotate.
- Do not switch the build to a prebuilt-image flow unless the release CI (which produces
  `dist/<arch>/artex`) is guaranteed to have run for that commit.
- Do not deploy the backend as a static frontend: the UI is embedded in the Go binary, so the
  service must stay a single container on port `8787`.
