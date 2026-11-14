# Usage:
#   make deploy              # build the sandbox images; deploy the <projectName>-Network, -Runtime and -Gateway stacks
#   make test                # unit tests, then integration tests against the deployed stacks
#   make test-unit           # type-check, CDK and Lambda unit tests, and the Python server tests; needs no AWS account
#                            # and no container engine
#   make test-integration    # call the deployed runtimes, tools Lambda and Gateway (Gateway tests need ACCESS_TOKEN)
#   make destroy
#
# Extra targets (need a container engine):
#   make test-container      # build one arm64 environment image (SANDBOX_ENVIRONMENT, default chem), run it on
#                            # loopback, and smoke-test it
#   make test-containers     # the same for every deployed environment, then the image size and layer report
#   make image-report        # image sizes (compressed, under the 2 GB V1 limit) and shared layers
#   make lock                # re-resolve every environment layer's hashed requirements.txt (needs PyPI access)
#
# Deploys need a running container engine (set CDK_DOCKER=finch for Finch).
# Pass CDK flags with CDK_ARGS, for example
#   CDK_ARGS="--profile dev -c jwtDiscoveryUrl=<url> -c jwtAllowedClients=<client-id>"
# Gateway integration tests run only when ACCESS_TOKEN holds an access token from your identity provider.

CDK := npx cdk
CDK_ARGS ?=
SERVER_DIR := containers/sandbox
SANDBOX_ENVIRONMENT ?= chem
CONTAINER_CLI ?= $(or $(CDK_DOCKER),$(shell command -v docker >/dev/null 2>&1 && echo docker || echo finch))
SMOKE_IMAGE := code-sandbox-mcp
LAYER_IMAGE := code-sandbox-layer
SMOKE_CONTAINER := code-sandbox-mcp-smoke
SMOKE_PORT ?= 18000
DEPLOYED_ENVIRONMENTS = $(shell node -p "require('./lib/sandbox/catalog.json').environments.filter((e) => e.deploy).map((e) => e.id).join(' ')")
ALL_LAYERS = $(shell node -p "require('./lib/sandbox/catalog.json').environments.map((e) => e.id).join(' ')")

.PHONY: deploy destroy test test-unit test-python test-integration test-container test-containers image-report lock

node_modules: package.json
	npm install
	@touch node_modules

deploy: node_modules
	$(CDK) deploy --all $(CDK_ARGS)

destroy: node_modules
	$(CDK) destroy --all $(CDK_ARGS)

test: test-unit test-integration

test-unit: node_modules test-python
	npm run build
	npm test

test-python:
	cd $(SERVER_DIR) && uv run --frozen pytest

test-integration: node_modules
	npm run test:integration

lock:
	cd $(SERVER_DIR) && uv run --frozen python scripts/sandbox_environments.py lock
	npm run environments:catalog

# The container port is published on loopback only.
test-container:
	$(CONTAINER_CLI) build --platform linux/arm64 --build-arg ENVIRONMENT=$(SANDBOX_ENVIRONMENT) -t $(SMOKE_IMAGE):$(SANDBOX_ENVIRONMENT) $(SERVER_DIR)
	-$(CONTAINER_CLI) rm -f $(SMOKE_CONTAINER) >/dev/null 2>&1
	$(CONTAINER_CLI) run -d --name $(SMOKE_CONTAINER) -p 127.0.0.1:$(SMOKE_PORT):8000 $(SMOKE_IMAGE):$(SANDBOX_ENVIRONMENT)
	@status=0; \
	for i in $$(seq 1 30); do \
	  $(CONTAINER_CLI) exec $(SMOKE_CONTAINER) python -c 'import socket; socket.create_connection(("127.0.0.1", 8000), 1).close()' >/dev/null 2>&1 && break; \
	  sleep 1; \
	done; \
	[ "$$($(CONTAINER_CLI) exec $(SMOKE_CONTAINER) id -u)" != "0" ] || { echo "container runs as root" >&2; status=1; }; \
	[ $$status -ne 0 ] || (cd $(SERVER_DIR) && uv run --frozen python scripts/smoke_test.py http://127.0.0.1:$(SMOKE_PORT) \
	  --environment $(SANDBOX_ENVIRONMENT)) || status=1; \
	[ $$status -eq 0 ] || $(CONTAINER_CLI) logs $(SMOKE_CONTAINER) >&2; \
	$(CONTAINER_CLI) rm -f $(SMOKE_CONTAINER) >/dev/null 2>&1; \
	exit $$status

test-containers:
	@for env in $(DEPLOYED_ENVIRONMENTS); do \
	  $(MAKE) --no-print-directory test-container SANDBOX_ENVIRONMENT=$$env || exit 1; \
	done
	$(MAKE) --no-print-directory image-report

# Tags each env-<layer> stage (cached from the image builds) so the report can compare layers, then writes every
# image's `image inspect` output and each environment image's gzipped size to a temporary directory, which
# scripts/image_report.py reads. bash for pipefail: a failed `save` must fail the target, not report a small image.
image-report: SHELL := /bin/bash
image-report:
	@for layer in $(ALL_LAYERS); do \
	  $(CONTAINER_CLI) build -q --platform linux/arm64 --target env-$$layer -t $(LAYER_IMAGE):$$layer $(SERVER_DIR) >/dev/null || exit 1; \
	done
	@set -o pipefail; dir=$$(mktemp -d); trap 'rm -rf "$$dir"' EXIT; \
	for layer in $(ALL_LAYERS); do \
	  $(CONTAINER_CLI) image inspect $(LAYER_IMAGE):$$layer > "$$dir/layer-$$layer.json" || exit 1; \
	done; \
	for env in $(DEPLOYED_ENVIRONMENTS); do \
	  $(CONTAINER_CLI) image inspect $(SMOKE_IMAGE):$$env > "$$dir/image-$$env.json" || exit 1; \
	  $(CONTAINER_CLI) save $(SMOKE_IMAGE):$$env | gzip -c | wc -c > "$$dir/image-$$env.gzip-bytes" || exit 1; \
	done; \
	cd $(SERVER_DIR) && uv run --frozen python scripts/image_report.py "$$dir"
