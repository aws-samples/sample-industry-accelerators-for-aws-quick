# Usage:
#   make deploy              # deploy the <projectName>-Tools and <projectName>-Gateway stacks
#   make test                # unit tests, then integration tests against the deployed stacks
#   make test-unit           # type-check and unit tests; needs no AWS account
#   make test-integration    # call the deployed Lambda (and the Gateway when ACCESS_TOKEN is set)
#   make destroy
#
# Pass CDK flags with CDK_ARGS, for example
#   CDK_ARGS="--profile dev -c jwtDiscoveryUrl=<url> -c jwtAllowedClients=<client-id>"
# Gateway integration tests run only when ACCESS_TOKEN holds an access token from your identity provider.

CDK := npx cdk
CDK_ARGS ?=

.PHONY: deploy destroy test test-unit test-integration

node_modules: package.json
	npm install
	@touch node_modules

deploy: node_modules
	$(CDK) deploy --all $(CDK_ARGS)

destroy: node_modules
	$(CDK) destroy --all $(CDK_ARGS)

test: test-unit test-integration

test-unit: node_modules
	npm run build
	npm test

test-integration: node_modules
	npm run test:integration
