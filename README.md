# riseup-connector

A small, **stateless** remote MCP server (Streamable HTTP) that wraps the official
[RiseUp MCP server](https://github.com/riseup-oss/mcp) (`@riseup-oss/mcp`) so you can
add it as a **custom connector on claude.ai** and use it from the Claude web, desktop
and mobile apps.

The upstream package is stdio-only and reads the token from `RISEUP_PAT`. This server
instead takes the RiseUp Personal Access Token (PAT) from the **URL of every request**
and stores no token anywhere:

```
https://<your-host>/mcp/<riseup_pat_...>
```

The token lives only in your claude.ai connector settings.

> **The full connector URL is the credential.** Anyone who has it can read your RiseUp
> budget and transactions until the token expires or is revoked. Don't paste it into
> chats, screenshots, issues or logs.

## How it works

- Tool names, descriptions and input schemas are taken from the upstream package
  (`registerBudgetTool`, `registerTransactionsTool`) through a small shim; the handlers
  are swapped for per-request ones that call upstream's `fetchBudget` /
  `fetchTransactions` with the PAT from the URL.
- Exposed tools: `get_budget`, `get_transactions` (read-only).
- RiseUp API base is hard-coded to `https://input.riseup.co.il` (no override).
- Stateless: a fresh `McpServer` + transport per request, `POST` only, 1 MB body limit.
- A missing, malformed or non-allowlisted token gets a plain `404 not found`.
- Request URLs, headers and tokens are never logged.
- `GET /healthz` returns `200 ok`.

## Setup

### 1. Create a RiseUp PAT

Go to <https://input.riseup.co.il/developer/tokens> and create a token with the
**`budget:read`** scope. Copy it — it is shown only once. It looks like
`riseup_pat_...`.

### 2. Hash it for the allowlist

The server can be locked to your token(s) by SHA-256 hash, so a stranger who finds the
hostname can't use it as an open proxy with their own token:

```sh
printf '%s' 'riseup_pat_...' | sha256sum
```

(Use `printf '%s'`, not `echo`, so no trailing newline is hashed. Prefix the command with
a space or clear your shell history afterwards.)

Create `.env` from the example and paste the hex digest:

```sh
cp .env.example .env
# ALLOWED_PAT_SHA256=<64 hex chars>   (comma-separate several during rotation)
```

If `ALLOWED_PAT_SHA256` is empty the server accepts any well-formed PAT and logs a
warning at startup.

### 3. Create a Cloudflare Tunnel

In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel**
(type *cloudflared*). Copy the tunnel token into `.env` as `TUNNEL_TOKEN`.

Add a **public hostname** for the tunnel (e.g. `riseup.example.com`) with service
**`http://riseup:8787`** (the compose service name — the `riseup` container publishes no
ports, so it is reachable only through the tunnel).

**Do not put Cloudflare Access in front of this hostname.** claude.ai connects from
Anthropic's servers and can't complete an Access login; the token in the URL (plus the
hash allowlist) is the authentication.

### 4. Start it

```sh
docker compose up -d --build
docker compose logs riseup     # "riseup-remote listening on :8787 (1 allowed PAT hash(es))"
curl https://riseup.example.com/healthz   # ok
```

### 5. Add the connector on claude.ai

**Settings → Connectors → Add custom connector**

- Name: `RiseUp`
- URL: `https://riseup.example.com/mcp/riseup_pat_...`
- Leave the OAuth fields empty.

Connectors added on claude.ai are available in the Android/iOS apps too. Enable the
connector in a chat and ask e.g. "what did I spend on restaurants this month?".

`https://<host>/mcp?pat=<PAT>` also works, but the path form is preferred.

## Token rotation (every 30 days)

RiseUp PATs expire after 30 days. To rotate:

1. Create a new PAT at <https://input.riseup.co.il/developer/tokens>.
2. Hash it and update `ALLOWED_PAT_SHA256` in `.env` (you can list old and new hashes,
   comma-separated, for a seamless switch), then `docker compose up -d`.
3. On claude.ai → Settings → Connectors, edit the connector URL to use the new PAT.
4. Remove the old hash from `.env`, `docker compose up -d`, and revoke the old PAT.

## Local development

```sh
npm install
npm run build
npm start            # listens on :8787 (PORT env to change)
```

Smoke test with a **fake** token (never use a real one in shell history):

```sh
FAKE=riseup_pat_$(printf 'a%.0s' $(seq 43))
curl -s -X POST "http://localhost:8787/mcp/$FAKE" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## When upstream adds a tool

The shim forwards only tools that have a remote handler; anything new is skipped with a
warning like `Skipping upstream tool "get_foo": no remote handler yet.`
(logged on each request). To add it:

1. Bump `@riseup-oss/mcp` in `package.json` (exact version) and run `npm install`.
2. Import the new `registerXTool` and its `fetchX` from
   `@riseup-oss/mcp/dist/tools/<file>.js` in `src/server.ts`.
3. Add an entry to `handlers` keyed by the tool name, calling `fetchX(args..., cfg)` and
   returning `json(result)` (copy any argument checks the upstream handler does).
4. Call `registerXTool(shim)` in `buildServer`.
5. `npm run build`, test with `tools/list`, then `docker compose up -d --build`.

Handlers must take the config from the `cfg` argument — never from
`loadConfigFromEnv()`, which reads `RISEUP_PAT`/`RISEUP_API_BASE` from the environment.
