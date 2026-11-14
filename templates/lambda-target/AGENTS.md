# Lambda target template

Read the root [AGENTS.md](../../AGENTS.md) first.

This is the reference copy of the shared building blocks. Accelerators copy
it, so keep it small, generic and industry-neutral.

- `lib/config/jwt-authorizer.ts` is identical in every accelerator. Change it
  here first, then copy the change to each accelerator.
- `lib/constructs/mcp-gateway.ts` supports Lambda targets only. Accelerators
  that need Runtime targets or an interceptor extend their own copy.
- The unit-converter tools are a placeholder. Keep them dependency-free and
  offline, so `make test-unit` runs anywhere.
- `TOOLS` in `lib/tools/unit-converter-tools.ts` and `HANDLERS` in
  `lambda/unit-converter/index.ts` must list the same tool names;
  `test/unit/handler.test.ts` checks this.
- Gateway inline tool schemas accept only `type`, `description`,
  `properties`, `required` and `items`. Don't add `enum`, `default` or
  annotations.
