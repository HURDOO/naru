# Naru

[한국어](README.ko.md)

**Continue the Codex and terminal sessions running on your Mac from any of your devices.**

Naru is a self-hosted web IDE for one person. Run it on a Mac you control, then reconnect to the
same Codex and terminal sessions from a desktop or mobile browser over your private network.
Closing the browser or switching devices does not end the work running on the Mac.

## Why Naru

- Pick up the same terminal or Codex session from another device.
- Arrange multiple terminals, Codex sessions, documents, and files in persistent panes.
- Discover Git worktrees without connecting or starting them until you choose to.
- Keep multiple browsers in sync while allowing exactly one of them to control terminal input.
- Reconnect to running sessions after the Naru server or optional Gateway restarts.
- Add passkey sign-in, an installable web app, and push notifications with Workstation Gateway.

Naru does not claim that a process survives a DurableSession Host or OS restart. If the Host
restarts, Naru restores the session record and reports the process as stopped.

## How it works

```text
desktop or mobile browser
           |
           v
Workstation Gateway (optional)   passkey, Origin, and network policy
           |
           v
Naru server + web UI             projects, panes, files, and layout
           |
           v
DurableSession Host              terminal process, output, and control
           |
           v
      shell / Codex CLI
```

The DurableSession Host owns the running process and terminal state. Naru manages the workspace
around it, while Workstation Gateway can provide a separate authentication and private-ingress
boundary. These layers use distinct permissions; access to the private network is not treated as
authentication.

## Before you run it

> [!WARNING]
> Naru exposes a shell with the permissions of the OS user who installed it. For normal use, put
> Naru behind Workstation Gateway and use its passkey authentication, exact Origin checks, and
> scoped app assertions.
>
> The Gateway does not make an unsafe network setup safe. Keep every listener and allowed source
> private and exact, review TLS, DNS, VPN, firewall, and router settings yourself, and never expose
> Naru directly to the public internet.

The current supported host and package target is macOS on Apple silicon. Naru is designed for one
OS user and one personal instance; multi-user access and role-based access control are not
supported.

## Source development

Install Node.js 24 LTS and pnpm 11.12.0, then run:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm password:hash
pnpm dev
```

Replace every placeholder in `.env` with development-only values. Never commit real secrets,
project paths, domains, IP addresses, certificates, or terminal output. See
[Getting started](docs/GETTING_STARTED.md) for the complete setup and
[Known limitations](docs/LIMITATIONS.md) before using Naru outside a local development environment.

## Security boundaries

- Project paths are resolved with `realpath` and must remain inside an approved root.
- HTTP mutations and WebSocket connections validate the exact Origin, session, and message shape.
- Gateway credentials are not forwarded to Naru; the Gateway exchanges them for a short-lived,
  scoped assertion.
- Host capabilities are bound to the application, caller, session, runtime, and generation.
- Cookies, private keys, capabilities, and raw terminal or Codex output are not written to the
  database or structured logs.
- Naru does not automatically change DNS, VPN, firewall, router, or certificate settings.

Read the full [security model](docs/SECURITY.md) and [architecture](docs/ARCHITECTURE.md) before
changing authentication, networking, process control, or path handling.

## Repository map

| Path                               | Purpose                                         |
| ---------------------------------- | ----------------------------------------------- |
| `apps/server/`, `apps/web/`        | Naru reference server and responsive web UI     |
| `apps/durable-session-host/`       | Terminal process lifecycle, output, and control |
| `packages/contracts/`              | Versioned protocol and runtime schemas          |
| `packages/durable-session-client/` | Public TypeScript client                        |
| `apps/cli/`                        | Same-user local session CLI                     |
| `apps/workstation-gateway/`        | Passkey Gateway and private-ingress adapters    |
| `ops/workstation/distribution/`    | Standalone macOS arm64 packaging                |
| `skills/`                          | Setup, integration, and operation skills        |

## Verification

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:operations
pnpm workstation:distribution:test
pnpm test:production-smoke
pnpm audit:security
pnpm public:scan
```

Contributions are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). Naru is licensed under
the [Apache License 2.0](LICENSE). Dependency, runtime, and bundled-font notices are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
