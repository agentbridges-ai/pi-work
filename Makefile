SHELL := /usr/bin/env bash

WEB_DIR := web
APPS_PLATFORM_DIR := packages/apps-platform
RUNTIME_DIR := .runtime
CRITICAL_TESTS_FILE := scripts/critical-tests.txt
COVERAGE_THRESHOLD ?= 80
VERIFY_SRT ?= 1
AUTH_CLI := npx --yes auth@1.6.20
PI_UPSTREAM_DIR := docs/upstream/pi
PI_UPSTREAM_REPO := https://github.com/earendil-works/pi.git

ifeq ($(VERIFY_SRT),1)
VERIFY_SRT_TARGETS := test-pi-rpc-contract test-srt-isolation test-srt-pi test-srt-user-space-transport test-srt-user-space-ipc
endif

.PHONY: help
help:
	@printf '%s\n' \
	  'Piwork local development commands' \
	  '' \
	  'Development:' \
	  '  make mise-install          Install tools pinned by mise.toml and mise.lock' \
	  '  make install              Install web dependencies' \
		  '  make agent-browser        Prepare the pinned agent-browser Chrome extension runtime' \
		  '  make agent-browser-e2e    Run the real Mac Chrome extension bridge smoke test' \
		  '  make dev                  Start verified Compose source stack (OrbStack/WSL2/Linux)' \
		  '  make dev-native           Start the in-process native Pi debug path' \
		  '  make dev-compose          Start Compose source explicitly' \
		  '  make selfhost-init        Generate Compose config and secret files' \
	  '  make selfhost-doctor      Check Compose and Runtime security' \
	  '  make selfhost-release-validate Validate the release image manifest' \
		  '  make selfhost-up          Start the fixed Compose stack' \
		  '  make selfhost-down        Stop the fixed Compose stack' \
		  '  make selfhost-backup      Create a DB/data backup' \
		  '  make selfhost-upgrade     Backup, migrate, smoke-test, and start' \
	  '  make dev-fast             Alias for make dev' \
	  '  make dev-fast-stop        Stop local dev processes' \
	  '  make status               Check Compose or native local health' \
	  '  make stop                 Alias for make dev-fast-stop' \
	  '  make auth-generate        Generate Better Auth SQL schema' \
	  '  make auth-migrate         Apply Better Auth Postgres schema' \
	  '  make rbac-migrate         Apply Piwork RBAC Postgres schema' \
	  '  make control-plane-migrate Apply tenant/Agent control-plane schema' \
	  '  make migrate              Apply auth, RBAC, and control-plane schemas' \
	  '' \
	  'Checks:' \
	  '  make verify               Frozen install + toolchain + full tests + build' \
	  '  make typecheck            Run TypeScript checks' \
	  '  make apps-check           Test and dry-run the ordinary Cloudflare App wrapper' \
	  '  make test                 Run the full Vitest suite' \
	  '  make test-coverage        Run the full Vitest suite once and emit LCOV' \
	  '  make test-targeted        Run focused local runtime tests' \
	  '  make test-pi-rpc-contract Run the native Pi JSONL RPC contract probe and tests' \
	  '  make test-srt-pi          Run real native Pi rpc-entry inside Linux SRT' \
	  '  make verify-pi-versions   Verify exact Pi and MCP SDK dependency pins' \
	  '  make verify-pi-upstream   Verify the pinned official Pi Git reference' \
	  '  make verify-pi-only-runtime  Reject legacy Agent runtime surfaces' \
	  '  make verify-actions-pinning  Reject mutable external GitHub Action references' \
	  '  make verify-onlyoffice-release  Verify the pinned OnlyOffice descriptor' \
	  '  make coverage-diff        Enforce 80% per-file diff coverage; whole-file for additions' \
	  '  make test-e2e             Run Better Auth Playwright E2E tests' \
	  '  make check                Run quality gates + targeted tests + production build' \
	  '  make lint                 Run ESLint over maintained web source' \
	  '  make format              Format maintained source, config, and docs' \
	  '  make format-check        Verify Prettier formatting' \
	  '  make deadcode             Run the dead-code TypeScript project' \
	  '  make dry-check            Run duplication check' \
	  '  make governance-check    Verify governance policy, docs, exceptions, and ownership' \
	  '  make security-check      Run dependency audit and license policy checks' \
	  '  make landing-check       Run frozen Landing install, lint, typecheck, build, and smoke' \
	  '  make release-check       Verify Release Please, versions, and release boundaries' \
	  '  make github-governance-check  Read back GitHub governance settings' \
	  '  make github-governance-apply  Dry-run/apply GitHub Teams, Rulesets, and merge settings' \
	  '' \
	  'Build:' \
	  '  make build                Build frontend dist' \
	  '' \
	  'Maintenance:' \
	  '  make backup               Create a locked Postgres + durable data backup' \
	  '  make backup-verify BACKUP=/path  Verify a backup without restoring it' \
	  '  make clean-runtime        Remove local runtime logs and pids' \
	  '  make sync-pi-upstream     Update the official Pi Git reference from main' \
	  '  make pi-reset-legacy-sessions  Dry-run the explicit legacy session reset' \
	  '  make dev-reset-sessions-hard  Hard-delete local data/ session state'

.PHONY: install mise-install agent-browser agent-browser-e2e
# SRT's package trust check rejects shared hardlinks. Bun defaults to hardlinks on
# Linux, so keep installed package metadata private to this checkout. A hoisted
# layout also gives the runtime, its transitive Pi modules, and TypeScript one
# canonical dependency tree inside the SRT allow-read root. Shared local packages
# additionally resolve their peer dependencies through the independent Web tree.
install: mise-install
	cd $(WEB_DIR) && mise --no-config exec --locked --no-deps "bun@$$(MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES=none mise config get tools.bun --raw)" -- bun install --backend copyfile --linker hoisted --frozen-lockfile
	cd landing-page && mise --no-config exec --locked --no-deps "bun@$$(MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES=none mise config get tools.bun --raw)" -- bun install --backend copyfile --linker isolated --frozen-lockfile
	@if [ ! -e "$(WEB_DIR)/node_modules" ] && [ ! -L "$(WEB_DIR)/node_modules" ]; then \
		ln -s ../node_modules "$(WEB_DIR)/node_modules"; \
	fi
	@if [ ! -e "packages/node_modules" ] && [ ! -L "packages/node_modules" ]; then \
		ln -s ../web/node_modules packages/node_modules; \
	fi

mise-install:
	@command -v mise >/dev/null 2>&1 || (echo 'mise is required; install it from https://mise.jdx.dev/getting-started.html' >&2; exit 1)
	MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES=none mise install --locked bun node

agent-browser:
	./scripts/ensure-agent-browser.sh

agent-browser-e2e: agent-browser
	node ./scripts/e2e-agent-browser-chrome-extension.mjs

.PHONY: dev dev-fast dev-native dev-compose require-compose-linux-runtime require-native-linux-runtime dev-fast-stop status stop
dev: dev-compose
dev-fast: agent-browser dev-compose
dev-native: require-native-linux-runtime
	./scripts/ensure-agent-browser.sh
	PIWORK_NATIVE_DEBUG=1 ./scripts/dev-local.sh

dev-compose: require-compose-linux-runtime
	./scripts/selfhost.sh init
	./scripts/selfhost.sh doctor
	./scripts/selfhost.sh up --source
	if ! ./scripts/selfhost.sh doctor --require-verified; then \
		./scripts/selfhost.sh down || true; \
		exit 1; \
	fi

require-compose-linux-runtime:
	@if ! command -v docker >/dev/null 2>&1; then \
		echo 'Docker is required for Compose development; use OrbStack on macOS or Docker in WSL2/Linux.' >&2; \
		exit 1; \
	fi; \
	engine="$$(docker info --format '{{.OSType}}' 2>/dev/null || true)"; \
	if [[ "$$engine" != "linux" ]]; then \
		echo 'Compose development requires a Linux Docker engine; use OrbStack on macOS or Docker in WSL2/Linux.' >&2; \
		exit 1; \
	fi

require-native-linux-runtime:
	@if [[ "$(shell uname -s)" != "Linux" ]]; then \
		echo 'Native Pi/SRT development requires a Linux execution host; use OrbStack Linux on macOS or WSL2 Linux on Windows.' >&2; \
		exit 1; \
	fi

dev-fast-stop:
	./scripts/selfhost.sh down 2>/dev/null || true
	./scripts/dev-local-stop.sh
status:
	@if [[ -f $(RUNTIME_DIR)/selfhost/selfhost.env ]]; then \
		./scripts/selfhost.sh status; \
		api_port="$${PIWORK_HTTP_PORT:-3457}"; \
		edge_headers="$$(curl -fsS -D - -o /dev/null "http://127.0.0.1:$$api_port/build-info" || true)"; \
		printf '%s\n' "$$edge_headers" | grep -Eqi '^X-Piwork-Edge:[[:space:]]*piwork-caddy[[:space:]]*$$' || (echo 'Published port is not served by Piwork Caddy' >&2; exit 1); \
		curl -fsS "http://127.0.0.1:$$api_port/api/health/ready" >/dev/null && echo "Compose API ready: http://127.0.0.1:$$api_port" || (echo 'Compose API is not ready' >&2; exit 1); \
		curl -fsS "http://127.0.0.1:$$api_port/" >/dev/null && echo "Compose frontend ready: http://127.0.0.1:$$api_port" || (echo 'Compose frontend is not ready' >&2; exit 1); \
	else \
		source $(RUNTIME_DIR)/ports.env 2>/dev/null || true; \
		api_port="$${PORT:-3457}"; \
		vite_port="$${VITE_PORT:-3458}"; \
		curl -fsS "http://127.0.0.1:$$api_port/build-info" >/dev/null && echo "local API ready: http://127.0.0.1:$$api_port" || (echo 'local API is not ready' >&2; exit 1); \
		curl -fsS "http://127.0.0.1:$$vite_port/index.html" >/dev/null && echo "frontend ready: http://127.0.0.1:$$vite_port" || (echo 'frontend is not ready' >&2; exit 1); \
	fi
stop: dev-fast-stop

.PHONY: auth-generate auth-migrate rbac-migrate control-plane-migrate migrate test-compose-migrate test-compose-runtime test-srt-isolation test-srt-user-space-ipc test-srt-user-space-transport test-srt-pi
auth-generate:
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	  if [ -z "$$DATABASE_URL" ]; then echo 'DATABASE_URL is required for Better Auth schema generation.' >&2; exit 1; fi; \
	  cd $(WEB_DIR) && $(AUTH_CLI) generate --config server/better-auth.ts --output server/migrations/better-auth.sql --yes
auth-migrate:
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	  if [ -z "$$DATABASE_URL" ]; then echo 'DATABASE_URL is required for Better Auth migrations.' >&2; exit 1; fi; \
	  cd $(WEB_DIR) && $(AUTH_CLI) migrate --config server/better-auth.ts --yes
rbac-migrate:
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	  if [ -z "$$DATABASE_URL" ]; then echo 'DATABASE_URL is required for RBAC migrations.' >&2; exit 1; fi; \
	  cd $(WEB_DIR) && bun scripts/apply-rbac-migration.ts
control-plane-migrate:
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	  if [ -z "$$DATABASE_URL" ]; then echo 'DATABASE_URL is required for control-plane migrations.' >&2; exit 1; fi; \
	  cd $(WEB_DIR) && bun scripts/apply-control-plane-migration.ts
migrate: auth-migrate rbac-migrate control-plane-migrate
test-compose-migrate:
	@./scripts/selfhost.sh up --source
test-compose-runtime:
	@./scripts/selfhost.sh doctor --require-verified
test-srt-isolation:
	@cd $(WEB_DIR) && bun scripts/verify-srt-isolation.ts $${SRT_CANARY_ARGS:---self-test}

test-srt-user-space-ipc:
	@if [[ "$(shell uname -s)" == "Darwin" ]]; then \
		cd $(WEB_DIR) && bun scripts/verify-srt-user-space-ipc.ts; \
	else \
		echo 'Skipping macOS-only SRT Unix-socket path canary on non-macOS.'; \
	fi

test-srt-user-space-transport:
	@cd $(WEB_DIR) && bun scripts/verify-srt-user-space-transport.ts

test-srt-pi:
	@if [[ "$(shell uname -s)" == "Linux" ]]; then \
		cd $(WEB_DIR) && bun scripts/verify-srt-pi-rpc.ts; \
	else \
		echo 'Skipping Linux-only native Pi SRT smoke; run this target inside OrbStack/WSL2 Linux.'; \
	fi

.PHONY: verify verify-actions-pinning verify-onlyoffice-release verify-toolchain verify-pi-versions verify-pi-only-runtime agent-browser-verify backup-self-test typecheck apps-check test test-coverage test-targeted test-pi-rpc-contract coverage-diff test-e2e lint format format-check deadcode dry-check governance-check security-check landing-check release-check github-governance-check github-governance-apply check
verify: install verify-toolchain verify-pi-versions verify-pi-upstream verify-pi-only-runtime verify-actions-pinning verify-onlyoffice-release agent-browser-verify governance-check security-check lint format-check deadcode dry-check typecheck test-coverage $(VERIFY_SRT_TARGETS) backup-self-test build

verify-actions-pinning:
	node ./scripts/verify-github-actions-pinning.mjs

verify-onlyoffice-release:
	node ./scripts/verify-onlyoffice-release.mjs $(ONLYOFFICE_RELEASE_VERIFY_ARGS)

verify-toolchain:
	./scripts/verify-toolchain.sh

verify-pi-versions:
	node ./scripts/verify-native-pi-dependencies.mjs

verify-pi-upstream:
	@test -e "$(PI_UPSTREAM_DIR)/.git" || (echo 'Initialize the Pi docs reference with: git submodule update --init $(PI_UPSTREAM_DIR)' >&2; exit 1)
	@test "$$(git -C "$(PI_UPSTREAM_DIR)" remote get-url origin)" = "$(PI_UPSTREAM_REPO)" || (echo 'Unexpected Pi upstream remote.' >&2; exit 1)
	@test "$$(git -C "$(PI_UPSTREAM_DIR)" rev-parse HEAD)" = "$$(git rev-parse ":$(PI_UPSTREAM_DIR)")" || (echo 'Pi upstream checkout does not match the superproject gitlink.' >&2; exit 1)
	@test -z "$$(git -C "$(PI_UPSTREAM_DIR)" status --porcelain)" || (echo 'Pi upstream checkout contains local changes.' >&2; exit 1)

verify-pi-only-runtime:
	./scripts/verify-pi-only-runtime.sh

agent-browser-verify:
	node ./scripts/verify-agent-browser-release.mjs

backup-self-test:
	./scripts/verify-backup.sh --self-test

typecheck:
	cd $(WEB_DIR) && bun run typecheck
apps-check:
	cd $(APPS_PLATFORM_DIR) && bun run check
lint:
	cd $(WEB_DIR) && bun run lint
format:
	cd $(WEB_DIR) && bun run format
format-check:
	cd $(WEB_DIR) && bun run format:check
test:
	cd $(WEB_DIR) && bun run test
test-coverage:
	cd $(WEB_DIR) && bun run test:coverage
test-targeted:
	@cd $(WEB_DIR) && bun scripts/critical-test-suite.ts $(CRITICAL_TESTS_FILE)
test-pi-rpc-contract:
	@cd $(WEB_DIR) && bun scripts/verify-pi-rpc-contract.ts
	@cd $(WEB_DIR) && test -f server/pi-rpc-contract.test.ts && test -f server/pi-rpc-transport.test.ts
	@cd $(WEB_DIR) && bun node_modules/vitest/vitest.mjs run \
	  server/pi-rpc-contract.test.ts \
	  server/pi-rpc-transport.test.ts \
	  server/pi-runtime-layout.test.ts \
	  server/pi-reset-legacy-sessions.test.ts
coverage-diff:
	@test -n "$(COVERAGE_BASE_SHA)" || (echo 'COVERAGE_BASE_SHA is required.' >&2; exit 2)
	@test -n "$(COVERAGE_HEAD_SHA)" || (echo 'COVERAGE_HEAD_SHA is required.' >&2; exit 2)
	cd $(WEB_DIR) && bun scripts/check-diff-coverage.ts \
	  --base "$(COVERAGE_BASE_SHA)" \
	  --head "$(COVERAGE_HEAD_SHA)" \
	  --lcov coverage/lcov.info \
	  --external-coverage-manifest scripts/external-coverage-boundaries.json \
	  --threshold "$(COVERAGE_THRESHOLD)"
test-e2e:
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	  if [ -z "$$PIWORK_E2E_DATABASE_URL" ]; then echo 'PIWORK_E2E_DATABASE_URL is required and must target a dedicated *e2e* database.' >&2; exit 2; fi; \
	  cd $(WEB_DIR) && bun run test:e2e
deadcode:
	cd $(WEB_DIR) && bun run deadcode:check
dry-check:
	cd $(WEB_DIR) && bun run dry:check
governance-check:
	node ./scripts/governance/check-governance.mjs
	node ./scripts/governance/governance-fixtures.mjs
	node ./scripts/verify-github-actions-pinning.mjs
security-check:
	node ./scripts/governance/security-check.mjs
landing-check:
	node ./scripts/governance/landing-check.mjs
release-check:
	node ./scripts/governance/release-check.mjs
github-governance-check:
	node ./scripts/governance/github-governance.mjs
github-governance-apply:
	node ./scripts/governance/github-governance.mjs $(GITHUB_GOVERNANCE_ARGS)
check: governance-check security-check release-check verify-actions-pinning verify-onlyoffice-release verify-pi-upstream verify-pi-only-runtime lint format-check deadcode dry-check typecheck apps-check test-targeted test-pi-rpc-contract landing-check build

.PHONY: landing-dev landing-build landing-lint
landing-dev:
	cd landing-page && bun run dev
landing-build:
	cd landing-page && bun run build
landing-lint:
	cd landing-page && bun run lint

.PHONY: build
build:
	cd $(WEB_DIR) && bun run build

.PHONY: backup backup-verify clean-runtime sync-pi-upstream pi-reset-legacy-sessions dev-reset-sessions-hard
backup:
	./scripts/backup-local.sh

.PHONY: selfhost-init selfhost-configure selfhost-doctor selfhost-release-validate selfhost-up selfhost-down selfhost-status selfhost-backup selfhost-restore selfhost-upgrade
selfhost-init:
	./scripts/selfhost.sh init
selfhost-configure:
	./scripts/selfhost.sh configure
selfhost-doctor:
	./scripts/selfhost.sh doctor
selfhost-release-validate:
	node ./scripts/release-manifest.mjs validate "$${PIWORK_RELEASE_MANIFEST:-release/piwork-compose-release-manifest.json}"
selfhost-up:
	./scripts/selfhost.sh up --source
selfhost-down:
	./scripts/selfhost.sh down
selfhost-status:
	./scripts/selfhost.sh status
selfhost-backup:
	./scripts/selfhost.sh backup
selfhost-restore:
	@test -n "$(BACKUP)" || (echo 'BACKUP=/path/to/backup is required.' >&2; exit 2)
	./scripts/selfhost.sh restore "$(BACKUP)"
selfhost-upgrade:
	./scripts/selfhost.sh upgrade --source

backup-verify:
	@if [ -z "$(BACKUP)" ]; then echo 'Usage: make backup-verify BACKUP=/path/to/backup' >&2; exit 2; fi
	./scripts/verify-backup.sh "$(BACKUP)"

clean-runtime:
	rm -rf $(RUNTIME_DIR)

sync-pi-upstream:
	git submodule update --init --remote --checkout "$(PI_UPSTREAM_DIR)"

pi-reset-legacy-sessions:
	./scripts/pi-reset-legacy-sessions.sh

dev-reset-sessions-hard:
	./scripts/dev-reset-sessions-hard.sh
