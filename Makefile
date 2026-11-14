# Runs a Makefile target in every accelerator and the template.
#
# Usage:
#   make list                # print the accelerator folders
#   make test-unit           # unit tests for every accelerator (no AWS needed)
#   make test-unit ACCELERATORS=industries/life-sciences/bio-viewers
#   make synth               # synthesize every app into its cdk.out, with cdk-nag reports, before a security scan
#
# Deploy, destroy and integration tests are run from an accelerator's own
# folder, one at a time; see its README.

ACCELERATORS ?= $(patsubst %/Makefile,%,$(sort $(wildcard industries/*/*/Makefile) $(wildcard templates/*/Makefile)))

# Placeholder identity provider settings: synthesis needs them, and nothing is deployed.
SYNTH_ARGS ?= -c jwtDiscoveryUrl=https://idp.example.com/.well-known/openid-configuration -c jwtAllowedClients=example-client

.PHONY: list test-unit synth

list:
	@for dir in $(ACCELERATORS); do echo $$dir; done

test-unit:
	@set -e; for dir in $(ACCELERATORS); do \
	  echo "==> $$dir"; \
	  $(MAKE) --no-print-directory -C $$dir test-unit; \
	done

synth:
	@set -e; for dir in $(ACCELERATORS); do \
	  echo "==> $$dir"; \
	  (cd $$dir && $(MAKE) --no-print-directory node_modules && npx cdk synth -q $(SYNTH_ARGS)); \
	done
