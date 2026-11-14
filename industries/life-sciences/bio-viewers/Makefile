# Usage:
#   make deploy              # build the bio-viewers image; deploy the <projectName>-Runtime and <projectName>-Gateway stacks
#   make test                # unit tests, then integration tests against the deployed stacks
#   make test-unit           # type-check, CDK unit tests and server tests; needs no AWS account or container engine
#   make test-python         # server tests only (uv)
#   make test-integration    # call the deployed stacks (and the Gateway MCP API when ACCESS_TOKEN is set)
#   make destroy
#
# Deploys build a linux/arm64 image, so they need a running container engine (set CDK_DOCKER=finch for Finch).
# Pass CDK flags with CDK_ARGS, for example
#   CDK_ARGS="--profile dev -c jwtDiscoveryUrl=<url> -c jwtAllowedClients=<client-id>"
# Gateway MCP integration tests run only when ACCESS_TOKEN holds an access token from your identity provider.

CDK := npx cdk
CDK_ARGS ?=
SERVER_DIR := containers/bio-viewers

.PHONY: deploy destroy test test-unit test-python test-integration

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
