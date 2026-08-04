SHELL := /usr/bin/env bash

WEB_DIR := web
RUNTIME_DIR := .runtime
CRITICAL_TESTS_FILE := scripts/critical-tests.txt
COVERAGE_THRESHOLD ?= 80
VERIFY_SRT ?= 1
AUTH_CLI := npx --yes auth@1.6.20

ifeq ($(VERIFY_SRT),1)
VERIFY_SRT_TARGETS := test-pi-rpc-contract test-srt-isolation test-srt-pi test-srt-user-space-transport test-srt-user-space-ipc
endif

.PHONY: help
help:
	@printf '%s\n' \
	  'Piwork local development commands' \
	  '' \
		  'Development:' \
		  '  make install              Install web dependencies' \
		  '  make agent-browser        Prepare the pinned agent-browser Chrome extension runtime' \
		  '  make agent-browser-e2e    Run the real Mac Chrome extension bridge smoke test' \
		  '  make dev                  Start local Bun API + Vite frontend' \
	  '  make dev-fast             Alias for make dev' \
	  '  make dev-fast-stop        Stop local dev processes' \
	  '  make status               Check local server and Vite health' \
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
	  '  make test                 Run the full Vitest suite' \
	  '  make test-coverage        Run the full Vitest suite once and emit LCOV' \
	  '  make test-targeted        Run focused local runtime tests' \
	  '  make test-pi-rpc-contract Run the native Pi JSONL RPC contract probe and tests' \
	  '  make test-srt-pi          Run real native Pi rpc-entry inside Linux SRT' \
	  '  make verify-pi-versions   Verify exact Pi and MCP SDK dependency pins' \
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
	  '' \
	  'Build:' \
	  '  make build                Build frontend dist' \
	  '' \
	  'Maintenance:' \
	  '  make backup               Create a locked Postgres + durable data backup' \
	  '  make backup-verify BACKUP=/path  Verify a backup without restoring it' \
	  '  make clean-runtime        Remove local runtime logs and pids' \
	  '  make pi-reset-legacy-sessions  Dry-run the explicit legacy session reset' \
	  '  make dev-reset-sessions-hard  Hard-delete local data/ session state'

.PHONY: install agent-browser agent-browser-e2e
# SRT's package trust check rejects shared hardlinks. Bun defaults to hardlinks on
# Linux, so keep installed package metadata private to this checkout. A hoisted
# layout also gives the runtime, its transitive Pi modules, and TypeScript one
# canonical dependency tree inside the SRT allow-read root.
install:
	cd $(WEB_DIR) && bun install --backend copyfile --linker hoisted --frozen-lockfile
	@if [ ! -e "$(WEB_DIR)/node_modules" ] && [ ! -L "$(WEB_DIR)/node_modules" ]; then \
		ln -s ../node_modules "$(WEB_DIR)/node_modules"; \
	fi

agent-browser:
	./scripts/ensure-agent-browser.sh

agent-browser-e2e: agent-browser
	node ./scripts/e2e-agent-browser-chrome-extension.mjs

.PHONY: dev dev-fast dev-fast-stop status stop
dev: dev-fast
dev-fast: agent-browser
	./scripts/dev-local.sh
dev-fast-stop:
	./scripts/dev-local-stop.sh
status:
	@source $(RUNTIME_DIR)/ports.env 2>/dev/null || true; \
	  api_port="$${PORT:-3457}"; \
	  vite_port="$${VITE_PORT:-3458}"; \
	  curl -fsS "http://127.0.0.1:$$api_port/build-info" >/dev/null && echo "local API ready: http://127.0.0.1:$$api_port" || (echo 'local API is not ready' >&2; exit 1); \
	  curl -fsS "http://127.0.0.1:$$vite_port/index.html" >/dev/null && echo "frontend ready: http://127.0.0.1:$$vite_port" || (echo 'frontend is not ready' >&2; exit 1)
stop: dev-fast-stop

.PHONY: auth-generate auth-migrate rbac-migrate control-plane-migrate migrate test-srt-isolation test-srt-user-space-ipc test-srt-user-space-transport test-srt-pi
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
		echo 'Skipping Linux-only native Pi SRT smoke on non-Linux.'; \
	fi

.PHONY: verify verify-actions-pinning verify-onlyoffice-release verify-toolchain verify-pi-versions verify-pi-only-runtime agent-browser-verify backup-self-test typecheck test test-coverage test-targeted test-pi-rpc-contract coverage-diff test-e2e lint format format-check deadcode dry-check check
verify: install verify-toolchain verify-pi-versions verify-pi-only-runtime verify-actions-pinning verify-onlyoffice-release agent-browser-verify lint format-check deadcode dry-check typecheck test-coverage $(VERIFY_SRT_TARGETS) backup-self-test build

verify-actions-pinning:
	node ./scripts/verify-github-actions-pinning.mjs

verify-onlyoffice-release:
	node ./scripts/verify-onlyoffice-release.mjs $(ONLYOFFICE_RELEASE_VERIFY_ARGS)

verify-toolchain:
	./scripts/verify-toolchain.sh

verify-pi-versions:
	node ./scripts/verify-native-pi-dependencies.mjs

verify-pi-only-runtime:
	./scripts/verify-pi-only-runtime.sh

agent-browser-verify:
	node ./scripts/verify-agent-browser-release.mjs

backup-self-test:
	./scripts/verify-backup.sh --self-test

typecheck:
	cd $(WEB_DIR) && bun run typecheck
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
check: verify-actions-pinning verify-onlyoffice-release verify-pi-only-runtime lint format-check deadcode dry-check typecheck test-targeted test-pi-rpc-contract build

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

.PHONY: backup backup-verify clean-runtime pi-reset-legacy-sessions dev-reset-sessions-hard
backup:
	./scripts/backup-local.sh

backup-verify:
	@if [ -z "$(BACKUP)" ]; then echo 'Usage: make backup-verify BACKUP=/path/to/backup' >&2; exit 2; fi
	./scripts/verify-backup.sh "$(BACKUP)"

clean-runtime:
	rm -rf $(RUNTIME_DIR)

pi-reset-legacy-sessions:
	./scripts/pi-reset-legacy-sessions.sh

dev-reset-sessions-hard:
	./scripts/dev-reset-sessions-hard.sh
