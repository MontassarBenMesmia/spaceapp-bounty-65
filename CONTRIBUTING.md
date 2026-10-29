# Contributing to SpaceApp

Advanced API settings are documented in the [configuration reference](docs/configuration-reference.md).

Use a checkout you own. Do not run development tests against an installed
operator instance or reuse its credentials, browser profiles, sockets or data.

## Development prerequisites

The monorepo requires Node **>=22.12 <23**, as declared in the root
`package.json`, and npm. Linux is the reference development environment;
Windows contributors can use WSL. Building `node-pty` may require Python 3,
Make and a C++ compiler if a compatible prebuilt binary is unavailable.
Use the patched Node release pinned in `.nvmrc` (22.23.4).

The `run-spaceapp` installer is a separate package with its own host Node
requirement. Installing the application and developing this monorepo have
different prerequisites; consult the selected installer's `engines` field.

From the repository root, install the locked dependencies:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

Skipping the Electron download is suitable for core development. Desktop
packaging requires its normal toolchain and separate platform acceptance.
Dependency installation may use the network; the smoke command below does not
need a provider account, API key, Docker, PostgreSQL or Temporal.

## First executed task, without a provider

```sh
npm run smoke:offline
```

This builds the CLI host and runs an explicitly **simulated runtime** through
the real Unix socket protocol and a real PTY child. It submits two arithmetic
tasks, checks their results, reconnects without replacing the process, and
resubmits an input key to verify duplicate suppression within that host's
retained session. The child receives an allowlisted environment. Its process,
socket and temporary directory are removed before success is reported.

Success is a JSON record with `mode: "SIMULATED_RUNTIME"`, `passed: true` and
`cleaned: true`. A wrong answer or early child exit fails the command. This is
a contributor transport/acceptance check, not evidence of AI quality, provider
authentication, native task resume, browser behavior or crash durability.

Unix socket paths are short. If your inherited `TMPDIR` is deeply nested,
select a short temporary directory you own and set `TMPDIR` for the command.
On Windows run this particular smoke check inside WSL or a Linux development
container. It does not certify the Windows/macOS installer.

## Make and verify a small change

Work on a branch, not on `main`, so the change can become a pull request:

```sh
git switch -c my-change
```

For example, change the synthetic task's result handling in
`scripts/fixtures/offline-cli.mjs`, then run:

```sh
npm run test:contributor
npm run check
```

The contributor regression tests reject incorrect task output and early process
exit, and check cleanup after both. Restore the intended behavior before
submitting a change. Use the tests for the affected workspace as well; the
offline smoke is not a substitute for them.

## Run the complete stack from source

Use Node 22.12 or newer within Node 22, npm, Python 3, make and a C++ compiler
(`build-essential` on Ubuntu; Xcode Command Line Tools on macOS). Start Docker
with Compose v2 first. On macOS, Docker Desktop or a running Colima Docker context
works; the runner preserves the Docker CLI's configured context for Docker commands
only. On Windows 11, use WSL2 with Docker Desktop's WSL integration and a checkout
in the Linux filesystem, for example `~/src/spaceapp`, rather than `/mnt/c`.
Restrictive Unix permissions and Unix sockets are required. Keep checkout paths
short enough that `.dev-stack/control.sock` is below 100 bytes.

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run dev:stack
```

The first start builds internal packages, installs the **exact** OpenCode version
declared in the Dockerfile under `.dev-stack/vendor`, and pulls the digest-pinned
PostgreSQL/pgvector and Temporal images from the maintained launcher Compose
template. It can take several minutes and needs internet access. The command
remains in the foreground and prints the web URL and a one-time owner setup token.
Open that URL, claim the installation with the token, choose your email/password,
then sign in normally. The token expires 15 minutes after API startup; restart
to issue a fresh expiry if needed. There is no dev-login bypass. Open **Getting
Started**, add an OpenCode terminal pane, and reach its real TUI. No paid provider
account is needed to open the TUI; running a model may need a provider account.

```sh
npm run dev:stack -- status
npm run dev:stack -- down
npm run dev:stack -- reset
```

Ctrl+C and `down` stop supervised source processes and this checkout's containers,
preserving its database and settings. `reset` additionally removes this checkout's
Compose containers, named volume, and `.dev-stack/` directory. It never targets an
installed SpaceApp, other Compose projects, or global provider settings. The state
marker includes a random project ID, so identical checkout paths in separate WSL
distributions sharing Docker Desktop still use different Compose projects. The state
directory is private (0700), secrets are created with 0600 permissions, and all
provider HOME/XDG directories and wrappers are local to it. Only the bootstrap
token is intentionally printed. Logs are in `.dev-stack/logs/`; review/redact them
before sharing, as application output can contain private task data.

Default listeners bind to **127.0.0.1**:

| Service | Port | Override |
| --- | --- | --- |
| Web/Vite | 14911 | `SPACE_DEV_WEB_PORT` |
| API | 14910 | `SPACE_DEV_API_PORT` |
| PostgreSQL | 15432 | `SPACE_DEV_POSTGRES_PORT` |
| Temporal | 17233 | `SPACE_DEV_TEMPORAL_PORT` |
| State-local OpenCode server | 14096 | `SPACE_DEV_OPENCODE_PORT` |

Set overrides on the start command, for example
`SPACE_DEV_WEB_PORT=15911 SPACE_DEV_API_PORT=15910 npm run dev:stack`.
Choose distinct unprivileged ports; installed-stack ports 4910/4911/5432/7233 are
rejected. Use the same settings on subsequent starts. Docker Engine 28 or newer is
recommended: older engines have a documented localhost-published-port caveat on
the same L2 network. Loopback configuration alone cannot establish network isolation
on those engines. See [Docker's port publishing documentation](https://docs.docker.com/engine/network/port-publishing/).

API source edits restart through `tsx watch`; web edits use Vite HMR, including the
terminal WebSocket proxy. After editing internal `packages/*` or worker code, run
`npm run dev:stack -- rebuild` in another terminal. It stops the existing stack,
rebuilds internal packages and worker, then runs the stack in that terminal's
foreground, preserving your database and settings. Optional browser/Chromium, root shell, companion applications,
Telegram jobs and provider integration setup are outside this contributor stack.
Workflows stay enabled; `/readyz` must report a running Temporal worker and CLI
host. A supervised child failure stops the stack with an explicit error.

If startup fails, inspect the named log file and fix the reported missing tool,
port collision, dependency build or Docker error. Start Docker before retrying.
If the runner was killed forcibly and `.dev-stack/running.lock` remains, first
verify its old processes have stopped; the runner deliberately does not kill
unverified PIDs from a stale file. Remove only that stale lock after verification,
then run `reset`. A copied checkout's ownership marker is rejected; never copy
runtime `.dev-stack` state between checkouts. Do not relax state permissions to
work around a Windows mount: move the checkout to the WSL Linux filesystem.

For the destructive, real-service acceptance check, explicitly reset your **dev**
state first (it requires a fresh installation):

```sh
npm run test:dev-stack
npm run dev:stack -- reset
npm run dev:stack:smoke
```

The acceptance script boots the real stack without a TTY, claims an owner over
HTTP, signs in with the new password, opens Getting Started, creates an OpenCode
pane and checks real TUI output through Vite's WebSocket proxy. Finally it resets
owned resources and checks for remaining containers, volumes and listeners. It
does not perform model inference. The Linux CI job runs this flow. Platform claims
in a contribution must be backed by actual Linux and macOS or WSL2 runs, alongside
the repository's required check/test/build/hygiene gates below.

## Checks before a commit

Run the full test suite as a regular user, with `rg` (ripgrep), `ffmpeg`, and
`sqlite3` on PATH. Permission fixtures depend on normal Unix access checks.
Existing Linux browser tests also expect Chrome at `/usr/bin/google-chrome`.

After `npm ci`, these commands work in this order, also on a fresh clone:

```sh
npm run check
npm test
npm run build
npm run hygiene:preflight
```

`npm run check` runs the dependency boundary check, builds the internal
`@space/*` packages in dependency order and then type-checks the apps, so it
does not need an earlier `npm run build`. `npm test` builds the internal
packages and runs the test suites in this checkout. `npm run build` also builds
the API, worker and web app. Run `npm run hygiene:preflight` before every
commit: it fails on untracked files and on staged runtime, secret, dependency,
generated or report paths. Commit from your branch; older releases of this
check also refuse to run on `main`.

Opt-in database and authenticated provider proofs require separate isolated
fixtures; skipped proofs are not passing evidence.

In the maintainers' source repository, `npm run check:claims` compares the
version, licence, Node requirement, runtime list and key constants stated in
the README and `docs/` with the code, and rejects unqualified latency or
isolation claims; maintainers run it when a change touches any of them. Current
results and known failures are indexed there in `docs/quality/README.md`, and
its `AGENTS.md` describes the guidance to read before changing session
attachment, room retention, control, readiness, polling or deployment.

Keep changes reviewable and include the exact commands and limitations of your
verification. Never include credentials, private transcripts or local runtime
state in a contribution.

## License of contributions

SpaceApp is licensed under the [MIT License](LICENSE). Contributions are
accepted under the same license (inbound = outbound): by submitting a
contribution you license it to everyone under the MIT License. You keep the
copyright of your contribution.

Every commit must carry a `Signed-off-by:` line with your real name and email,
which certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the contribution or have the right to submit it under the MIT
License. `git commit -s` adds the line. There is no separate contributor
license agreement.

## Reviews and payment

Pull requests are reviewed and merged by the maintainers named in the public repository's `MAINTAINERS`
file. A merged pull request stays in every later release with its author.

Contributions are voluntary; payment applies only to issues labelled 💎 Bounty, under the terms posted on
that issue.
