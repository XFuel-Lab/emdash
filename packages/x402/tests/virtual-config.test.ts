/**
 * Virtual config module tests
 *
 * - Plain config serializes as before
 * - Hook references become static imports
 * - Relative hook paths resolve from the project root
 * - waitUntil comes from cloudflare:workers only under the Cloudflare adapter
 * - Functions and malformed references fail with an actionable error
 */

import { describe, it, expect } from "vitest";

import type { X402Config } from "../src/types.js";
import { generateConfigModule, validateHooks } from "../src/virtual-config.js";

const baseConfig: X402Config = {
	payTo: "0xTestWallet",
	network: "eip155:8453",
	defaultPrice: "$0.01",
};

const root = "/project";

describe("generateConfigModule()", () => {
	it("serializes a config without hooks and exports no waitUntil", () => {
		const source = generateConfigModule(baseConfig, {
			root,
			adapterName: "@astrojs/cloudflare",
		});

		expect(source).toContain(`const config = ${JSON.stringify(baseConfig)};`);
		expect(source).toContain("export default config;");
		expect(source).toContain("export const waitUntil = undefined;");
		expect(source).not.toContain("cloudflare:workers");
	});

	it("imports hooks from module references", () => {
		const source = generateConfigModule(
			{
				...baseConfig,
				onSettled: { module: "./src/x402-hooks.ts", export: "logPaidRead" },
				onError: { module: "@acme/x402-hooks" },
			},
			{ root },
		);

		expect(source).toContain(
			'import { logPaidRead as __x402_onSettled } from "/project/src/x402-hooks.ts";',
		);
		expect(source).toContain('import { onError as __x402_onError } from "@acme/x402-hooks";');
		expect(source).toContain("config.onSettled = __x402_onSettled;");
		expect(source).toContain("config.onError = __x402_onError;");
		expect(source).not.toContain('"module"');
	});

	it("defaults the export name to the option name", () => {
		const source = generateConfigModule(
			{ ...baseConfig, onSettled: { module: "./hooks.js" } },
			{ root },
		);

		expect(source).toContain('import { onSettled as __x402_onSettled } from "/project/hooks.js";');
	});

	it("re-exports waitUntil from cloudflare:workers under the Cloudflare adapter", () => {
		const source = generateConfigModule(
			{ ...baseConfig, onSettled: { module: "./hooks.js" } },
			{ root, adapterName: "@astrojs/cloudflare" },
		);

		expect(source).toContain('import { waitUntil as __x402_waitUntil } from "cloudflare:workers";');
		expect(source).toContain("export const waitUntil = __x402_waitUntil;");
	});

	it("exports an undefined waitUntil on other adapters", () => {
		const source = generateConfigModule(
			{ ...baseConfig, onSettled: { module: "./hooks.js" } },
			{ root, adapterName: "@astrojs/node" },
		);

		expect(source).not.toContain("cloudflare:workers");
		expect(source).toContain("export const waitUntil = undefined;");
	});
});

describe("validateHooks()", () => {
	it("accepts configs without hooks", () => {
		expect(() => validateHooks(baseConfig)).not.toThrow();
	});

	it("rejects a function with a hint to use a module reference", () => {
		expect(() => validateHooks({ ...baseConfig, onSettled: () => {} })).toThrow(
			/cannot be a function in astro.config/,
		);
	});

	it("rejects a reference without a module", () => {
		expect(() =>
			validateHooks({ ...baseConfig, onError: { export: "x" } as unknown as { module: string } }),
		).toThrow(/must be a module reference/);
	});

	it("rejects an export name that is not an identifier", () => {
		expect(() =>
			validateHooks({ ...baseConfig, onSettled: { module: "./hooks.js", export: "a-b" } }),
		).toThrow(/valid JavaScript identifier/);
	});
});
