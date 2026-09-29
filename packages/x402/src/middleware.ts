/**
 * x402 Astro Middleware
 *
 * Injected by the x402 integration. Creates the enforcer and
 * places it on Astro.locals.x402 for use in page frontmatter.
 *
 * The config is passed via the virtual module resolved by the integration.
 */

import { defineMiddleware } from "astro:middleware";
// The integration injects config via a virtual module.
// @ts-ignore -- virtual module, resolved at build time
import x402Config, { waitUntil } from "virtual:x402/config";

import { createEnforcer } from "./enforcer.js";
import type { X402Config, X402Runtime } from "./types.js";

// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- virtual module import has no type info
const config: X402Config = x402Config as X402Config;
// `waitUntil` is re-exported from cloudflare:workers under the Cloudflare
// adapter when hooks are configured, and undefined otherwise.
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- virtual module import has no type info
const enforcer = createEnforcer(config, { waitUntil: waitUntil as X402Runtime["waitUntil"] });

export const onRequest = defineMiddleware(async (context, next) => {
	context.locals.x402 = enforcer;
	return next();
});
