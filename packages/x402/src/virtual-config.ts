/**
 * Virtual config module generation.
 *
 * The integration config crosses from `astro.config.mjs` into the server
 * bundle as generated source, so it must be serializable. Hooks are passed as
 * module references and turned into static imports here, and under the
 * Cloudflare adapter `waitUntil` is re-exported from `cloudflare:workers` so
 * deferred hooks can outlive the response.
 */

import { isAbsolute, resolve } from "node:path";

import type { X402Config, X402HookReference } from "./types.js";

const HOOK_OPTIONS = ["onSettled", "onError"] as const;
type HookOption = (typeof HOOK_OPTIONS)[number];

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

function isHookReference(value: unknown): value is X402HookReference {
	return (
		value != null && typeof value === "object" && typeof Reflect.get(value, "module") === "string"
	);
}

function resolveSpecifier(specifier: string, root: string): string {
	if (specifier.startsWith(".")) return resolve(root, specifier);
	if (isAbsolute(specifier)) return specifier;
	return specifier;
}

function validateHook(name: HookOption, value: unknown): X402HookReference | undefined {
	if (value == null) return undefined;
	if (typeof value === "function") {
		throw new Error(
			`x402: \`${name}\` cannot be a function in astro.config because the config is serialized into the build. ` +
				`Pass a module reference instead, e.g. \`${name}: { module: "./src/x402-hooks.ts", export: "${name}" }\`.`,
		);
	}
	if (!isHookReference(value)) {
		throw new Error(
			`x402: \`${name}\` must be a module reference: { module: string; export?: string }.`,
		);
	}
	const exportName = value.export ?? name;
	if (!IDENTIFIER_PATTERN.test(exportName)) {
		throw new Error(
			`x402: \`${name}.export\` must be a valid JavaScript identifier, got "${exportName}".`,
		);
	}
	return { module: value.module, export: exportName };
}

/**
 * Validate hook options. Throws with an actionable message when a hook is
 * passed in a form that cannot be serialized into the build.
 */
export function validateHooks(config: X402Config): void {
	for (const name of HOOK_OPTIONS) validateHook(name, config[name]);
}

/**
 * Generate the source of `virtual:x402/config`.
 *
 * @param config - The integration config passed to `x402()`
 * @param options.root - Absolute path of the Astro project root
 * @param options.adapterName - Name of the configured Astro adapter, if any
 */
export function generateConfigModule(
	config: X402Config,
	options: { root: string; adapterName?: string },
): string {
	const imports: string[] = [];
	const assignments: string[] = [];

	const serializable: Record<string, unknown> = { ...config };
	for (const name of HOOK_OPTIONS) {
		const ref = validateHook(name, config[name]);
		delete serializable[name];
		if (!ref) continue;
		const local = `__x402_${name}`;
		imports.push(
			`import { ${ref.export} as ${local} } from ${JSON.stringify(resolveSpecifier(ref.module, options.root))};`,
		);
		assignments.push(`config.${name} = ${local};`);
	}

	// Only pull in cloudflare:workers when there is deferred work to extend.
	const hasHooks = assignments.length > 0;
	if (hasHooks && options.adapterName === "@astrojs/cloudflare") {
		imports.push(`import { waitUntil as __x402_waitUntil } from "cloudflare:workers";`);
	}
	const waitUntilExport =
		hasHooks && options.adapterName === "@astrojs/cloudflare"
			? "export const waitUntil = __x402_waitUntil;"
			: "export const waitUntil = undefined;";

	return [
		...imports,
		`const config = ${JSON.stringify(serializable)};`,
		...assignments,
		"export default config;",
		waitUntilExport,
	].join("\n");
}
