/**
 * x402 Enforcer Tests
 *
 * Tests the x402 payment enforcement logic:
 * - createEnforcer() creates a valid enforcer
 * - enforce() returns 402 when no payment header is present
 * - enforce() verifies and settles valid payments
 * - enforce() returns 402 for invalid payments
 * - hasPayment() checks for payment headers
 * - applyHeaders() sets response headers
 * - botOnly mode skips enforcement for humans
 * - Price normalization ($ prefix stripping)
 * - Error when no price is configured
 * - onSettled hook: payload, gating, error isolation, waitUntil
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { X402Config, X402Enforcer, X402Runtime } from "../src/types.js";

// Mock instances
const mockBuildPaymentRequirements = vi.fn();
const mockCreatePaymentRequiredResponse = vi.fn();
const mockFindMatchingRequirements = vi.fn();
const mockVerifyPayment = vi.fn();
const mockSettlePayment = vi.fn();
const mockInitialize = vi.fn().mockResolvedValue(undefined);

const mockResourceServer = {
	buildPaymentRequirements: mockBuildPaymentRequirements,
	createPaymentRequiredResponse: mockCreatePaymentRequiredResponse,
	findMatchingRequirements: mockFindMatchingRequirements,
	verifyPayment: mockVerifyPayment,
	settlePayment: mockSettlePayment,
	initialize: mockInitialize,
	register: vi.fn().mockReturnThis(),
};

const mockEncodePaymentRequiredHeader = vi.fn().mockReturnValue("encoded-payment-required");
const mockDecodePaymentSignatureHeader = vi.fn();
const mockEncodePaymentResponseHeader = vi.fn().mockReturnValue("encoded-payment-response");

vi.mock("@x402/core/server", () => ({
	HTTPFacilitatorClient: vi.fn(),
	x402ResourceServer: vi.fn().mockImplementation(function () {
		return mockResourceServer;
	}),
}));

vi.mock("@x402/core/http", () => ({
	encodePaymentRequiredHeader: (...args: unknown[]) => mockEncodePaymentRequiredHeader(...args),
	decodePaymentSignatureHeader: (...args: unknown[]) => mockDecodePaymentSignatureHeader(...args),
	encodePaymentResponseHeader: (...args: unknown[]) => mockEncodePaymentResponseHeader(...args),
}));

vi.mock("@x402/evm/exact/server", () => ({
	ExactEvmScheme: vi.fn(),
}));

const defaultConfig: X402Config = {
	payTo: "0xTestWallet",
	network: "eip155:8453",
	defaultPrice: "$0.01",
	facilitatorUrl: "https://test-facilitator.example.com",
};

function makeRequest(
	url: string,
	headers?: Record<string, string>,
	cf?: { botManagement?: { score?: number } },
): Request {
	const req = new Request(url, { headers });
	if (cf) {
		(req as unknown as { cf: typeof cf }).cf = cf;
	}
	return req;
}

/** Re-import the enforcer module to reset the cached singleton */
async function freshEnforcer(config: X402Config, runtime?: X402Runtime): Promise<X402Enforcer> {
	const mod = await import("../src/enforcer.js");
	return mod.createEnforcer(config, runtime);
}

/** Let deferred hooks (scheduled on a zero-delay timer) run. */
async function flushDeferred(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 5));
}

const paidPayload = { x402Version: 2, payload: {} };
const paidRequirements = [{ scheme: "exact", network: "eip155:8453" }];
const paidMatchingReqs = {
	scheme: "exact",
	network: "eip155:8453",
	asset: "0xAsset",
	amount: "10000",
	payTo: "0xTestWallet",
	maxTimeoutSeconds: 60,
	extra: {},
};
const paidSettlement = {
	success: true,
	transaction: "0xTxHash",
	network: "eip155:8453",
	payer: "0xPayerWallet",
};

/** Arrange mocks for a request that verifies and settles successfully. */
function mockSuccessfulPayment(): void {
	mockDecodePaymentSignatureHeader.mockReturnValue(paidPayload);
	mockBuildPaymentRequirements.mockResolvedValue(paidRequirements);
	mockFindMatchingRequirements.mockReturnValue(paidMatchingReqs);
	mockVerifyPayment.mockResolvedValue({ isValid: true, payer: "0xPayerWallet" });
	mockSettlePayment.mockResolvedValue(paidSettlement);
}

function paidRequest(): Request {
	return makeRequest("https://example.com/premium-article?ref=feed", {
		"payment-signature": "valid-payment-sig",
	});
}

describe("createEnforcer()", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		mockBuildPaymentRequirements.mockReset();
		mockCreatePaymentRequiredResponse.mockReset();
		mockFindMatchingRequirements.mockReset();
		mockVerifyPayment.mockReset();
		mockSettlePayment.mockReset();
		mockInitialize.mockResolvedValue(undefined);
	});

	describe("enforce()", () => {
		it("returns 402 when no payment header is present", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const request = makeRequest("https://example.com/premium-article");

			const mockRequirements = [{ scheme: "exact", network: "eip155:8453" }];
			const mockPaymentRequired = {
				x402Version: 2,
				accepts: mockRequirements,
				resource: { url: "/premium-article" },
			};

			mockBuildPaymentRequirements.mockResolvedValue(mockRequirements);
			mockCreatePaymentRequiredResponse.mockResolvedValue(mockPaymentRequired);

			const result = await enforcer.enforce(request);

			expect(result).toBeInstanceOf(Response);
			const response = result as Response;
			expect(response.status).toBe(402);
			expect(response.headers.get("PAYMENT-REQUIRED")).toBe("encoded-payment-required");
			expect(response.headers.get("Content-Type")).toBe("application/json");

			const body = await response.json();
			expect(body.x402Version).toBe(2);
		});

		it("returns EnforceResult when payment is valid", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const request = makeRequest("https://example.com/premium-article", {
				"payment-signature": "valid-payment-sig",
			});

			const mockPayload = { x402Version: 2, payload: {} };
			const mockRequirements = [{ scheme: "exact", network: "eip155:8453" }];
			const mockMatchingReqs = { scheme: "exact", network: "eip155:8453" };

			mockDecodePaymentSignatureHeader.mockReturnValue(mockPayload);
			mockBuildPaymentRequirements.mockResolvedValue(mockRequirements);
			mockFindMatchingRequirements.mockReturnValue(mockMatchingReqs);
			mockVerifyPayment.mockResolvedValue({
				isValid: true,
				payer: "0xPayerWallet",
			});
			mockSettlePayment.mockResolvedValue({
				success: true,
				transaction: "0xTxHash",
				network: "eip155:8453",
				payer: "0xPayerWallet",
			});

			const result = await enforcer.enforce(request);

			expect(result).not.toBeInstanceOf(Response);
			const enforceResult = result as {
				paid: boolean;
				skipped: boolean;
				payer?: string;
				responseHeaders: Record<string, string>;
			};
			expect(enforceResult.paid).toBe(true);
			expect(enforceResult.skipped).toBe(false);
			expect(enforceResult.payer).toBe("0xPayerWallet");
			expect(enforceResult.responseHeaders["PAYMENT-RESPONSE"]).toBe("encoded-payment-response");
		});

		it("returns 402 when payment verification fails", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const request = makeRequest("https://example.com/premium-article", {
				"payment-signature": "invalid-payment-sig",
			});

			const mockPayload = { x402Version: 2, payload: {} };
			const mockRequirements = [{ scheme: "exact", network: "eip155:8453" }];
			const mockMatchingReqs = { scheme: "exact", network: "eip155:8453" };
			const mockPaymentRequired = {
				x402Version: 2,
				error: "insufficient_balance",
				accepts: mockRequirements,
			};

			mockDecodePaymentSignatureHeader.mockReturnValue(mockPayload);
			mockBuildPaymentRequirements.mockResolvedValue(mockRequirements);
			mockFindMatchingRequirements.mockReturnValue(mockMatchingReqs);
			mockVerifyPayment.mockResolvedValue({
				isValid: false,
				invalidReason: "insufficient_balance",
			});
			mockCreatePaymentRequiredResponse.mockResolvedValue(mockPaymentRequired);

			const result = await enforcer.enforce(request);

			expect(result).toBeInstanceOf(Response);
			expect((result as Response).status).toBe(402);
		});

		it("returns 402 when payment doesn't match requirements", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const request = makeRequest("https://example.com/premium-article", {
				"payment-signature": "mismatched-payment-sig",
			});

			const mockPayload = { x402Version: 2, payload: {} };
			const mockRequirements = [{ scheme: "exact", network: "eip155:8453" }];
			const mockPaymentRequired = {
				x402Version: 2,
				error: "Payment does not match accepted requirements",
				accepts: mockRequirements,
			};

			mockDecodePaymentSignatureHeader.mockReturnValue(mockPayload);
			mockBuildPaymentRequirements.mockResolvedValue(mockRequirements);
			mockFindMatchingRequirements.mockReturnValue(undefined);
			mockCreatePaymentRequiredResponse.mockResolvedValue(mockPaymentRequired);

			const result = await enforcer.enforce(request);

			expect(result).toBeInstanceOf(Response);
			expect((result as Response).status).toBe(402);
		});

		it("throws when no price is configured", async () => {
			const enforcer = await freshEnforcer({
				payTo: "0xTestWallet",
				network: "eip155:8453",
			});
			const request = makeRequest("https://example.com/premium-article");

			await expect(enforcer.enforce(request)).rejects.toThrow("No price specified");
		});

		it("allows overriding price per-request", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const request = makeRequest("https://example.com/premium-article");

			const mockRequirements = [{ scheme: "exact", network: "eip155:8453" }];
			mockBuildPaymentRequirements.mockResolvedValue(mockRequirements);
			mockCreatePaymentRequiredResponse.mockResolvedValue({
				x402Version: 2,
				accepts: mockRequirements,
			});

			await enforcer.enforce(request, { price: "$0.50" });

			expect(mockBuildPaymentRequirements).toHaveBeenCalledWith(
				expect.objectContaining({ price: "0.50" }),
			);
		});

		it("allows overriding payTo per-request", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const request = makeRequest("https://example.com/premium-article");

			const mockRequirements = [{ scheme: "exact", network: "eip155:8453" }];
			mockBuildPaymentRequirements.mockResolvedValue(mockRequirements);
			mockCreatePaymentRequiredResponse.mockResolvedValue({
				x402Version: 2,
				accepts: mockRequirements,
			});

			await enforcer.enforce(request, { payTo: "0xOverrideWallet" });

			expect(mockBuildPaymentRequirements).toHaveBeenCalledWith(
				expect.objectContaining({ payTo: "0xOverrideWallet" }),
			);
		});

		it("reads PAYMENT-SIGNATURE header (case-insensitive)", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const request = makeRequest("https://example.com/premium-article", {
				"PAYMENT-SIGNATURE": "valid-payment-sig",
			});

			const mockPayload = { x402Version: 2, payload: {} };
			const mockRequirements = [{ scheme: "exact", network: "eip155:8453" }];
			const mockMatchingReqs = { scheme: "exact", network: "eip155:8453" };

			mockDecodePaymentSignatureHeader.mockReturnValue(mockPayload);
			mockBuildPaymentRequirements.mockResolvedValue(mockRequirements);
			mockFindMatchingRequirements.mockReturnValue(mockMatchingReqs);
			mockVerifyPayment.mockResolvedValue({ isValid: true, payer: "0xPayer" });
			mockSettlePayment.mockResolvedValue({
				success: true,
				transaction: "0xTx",
				network: "eip155:8453",
			});

			const result = await enforcer.enforce(request);
			expect(result).not.toBeInstanceOf(Response);
		});
	});

	describe("onSettled hook", () => {
		it("is called once with the settlement details after a successful settle", async () => {
			const onSettled = vi.fn();
			const enforcer = await freshEnforcer({ ...defaultConfig, onSettled });
			mockSuccessfulPayment();
			const request = paidRequest();

			const result = await enforcer.enforce(request, {
				description: "Premium article",
				mimeType: "text/html",
			});
			await flushDeferred();

			expect(result).not.toBeInstanceOf(Response);
			expect(onSettled).toHaveBeenCalledTimes(1);
			expect(onSettled).toHaveBeenCalledWith({
				payer: "0xPayerWallet",
				settlement: paidSettlement,
				requirements: paidMatchingReqs,
				resource: {
					url: "/premium-article",
					description: "Premium article",
					mimeType: "text/html",
				},
				request,
			});
		});

		it("runs after enforce() returns, even for synchronous work", async () => {
			const order: string[] = [];
			const enforcer = await freshEnforcer({
				...defaultConfig,
				onSettled: () => {
					order.push("hook");
				},
			});
			mockSuccessfulPayment();

			await enforcer.enforce(paidRequest());
			order.push("returned");
			await flushDeferred();

			expect(order).toEqual(["returned", "hook"]);
		});

		it("does not wait for a slow async hook", async () => {
			let release: () => void = () => {};
			const onSettled = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			);
			const enforcer = await freshEnforcer({ ...defaultConfig, onSettled });
			mockSuccessfulPayment();

			const result = await enforcer.enforce(paidRequest());
			expect(result).not.toBeInstanceOf(Response);
			expect((result as { paid: boolean }).paid).toBe(true);

			release();
			await flushDeferred();
			expect(onSettled).toHaveBeenCalledTimes(1);
		});

		it("is not called when no payment header is present", async () => {
			const onSettled = vi.fn();
			const enforcer = await freshEnforcer({ ...defaultConfig, onSettled });
			mockBuildPaymentRequirements.mockResolvedValue(paidRequirements);
			mockCreatePaymentRequiredResponse.mockResolvedValue({
				x402Version: 2,
				accepts: paidRequirements,
			});

			const result = await enforcer.enforce(makeRequest("https://example.com/premium-article"));
			await flushDeferred();

			expect((result as Response).status).toBe(402);
			expect(onSettled).not.toHaveBeenCalled();
		});

		it("is not called when the payment does not match requirements", async () => {
			const onSettled = vi.fn();
			const enforcer = await freshEnforcer({ ...defaultConfig, onSettled });
			mockSuccessfulPayment();
			mockFindMatchingRequirements.mockReturnValue(undefined);
			mockCreatePaymentRequiredResponse.mockResolvedValue({
				x402Version: 2,
				accepts: paidRequirements,
			});

			const result = await enforcer.enforce(paidRequest());
			await flushDeferred();

			expect((result as Response).status).toBe(402);
			expect(onSettled).not.toHaveBeenCalled();
		});

		it("is not called when verification fails", async () => {
			const onSettled = vi.fn();
			const enforcer = await freshEnforcer({ ...defaultConfig, onSettled });
			mockSuccessfulPayment();
			mockVerifyPayment.mockResolvedValue({
				isValid: false,
				invalidReason: "insufficient_balance",
			});
			mockCreatePaymentRequiredResponse.mockResolvedValue({
				x402Version: 2,
				accepts: paidRequirements,
			});

			const result = await enforcer.enforce(paidRequest());
			await flushDeferred();

			expect((result as Response).status).toBe(402);
			expect(onSettled).not.toHaveBeenCalled();
			expect(mockSettlePayment).not.toHaveBeenCalled();
		});

		it("is not called when settlement reports failure", async () => {
			const onSettled = vi.fn();
			const enforcer = await freshEnforcer({ ...defaultConfig, onSettled });
			mockSuccessfulPayment();
			mockSettlePayment.mockResolvedValue({
				...paidSettlement,
				success: false,
				errorReason: "transaction_failed",
			});

			await enforcer.enforce(paidRequest());
			await flushDeferred();

			expect(onSettled).not.toHaveBeenCalled();
		});

		it("is not called when settlement throws", async () => {
			const onSettled = vi.fn();
			const enforcer = await freshEnforcer({ ...defaultConfig, onSettled });
			mockSuccessfulPayment();
			mockSettlePayment.mockRejectedValue(new Error("settle failed"));

			await expect(enforcer.enforce(paidRequest())).rejects.toThrow("settle failed");
			await flushDeferred();

			expect(onSettled).not.toHaveBeenCalled();
		});

		it("is not called when enforcement is skipped in botOnly mode", async () => {
			const onSettled = vi.fn();
			const enforcer = await freshEnforcer({ ...defaultConfig, botOnly: true, onSettled });

			const result = await enforcer.enforce(makeRequest("https://example.com/article"));
			await flushDeferred();

			expect((result as { skipped: boolean }).skipped).toBe(true);
			expect(onSettled).not.toHaveBeenCalled();
		});

		it("swallows a synchronous throw and logs it", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const error = new Error("hook exploded");
			const enforcer = await freshEnforcer({
				...defaultConfig,
				onSettled: () => {
					throw error;
				},
			});
			mockSuccessfulPayment();

			const result = await enforcer.enforce(paidRequest());
			await flushDeferred();

			expect(result).not.toBeInstanceOf(Response);
			expect((result as { paid: boolean }).paid).toBe(true);
			expect((result as { responseHeaders: Record<string, string> }).responseHeaders).toEqual({
				"PAYMENT-RESPONSE": "encoded-payment-response",
			});
			expect(warn).toHaveBeenCalledWith("[x402] onSettled hook failed:", error);
			warn.mockRestore();
		});

		it("swallows an async rejection and passes it to onError", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const error = new Error("analytics down");
			const onError = vi.fn();
			const enforcer = await freshEnforcer({
				...defaultConfig,
				onSettled: () => Promise.reject(error),
				onError,
			});
			mockSuccessfulPayment();
			const request = paidRequest();

			const result = await enforcer.enforce(request);
			await flushDeferred();

			expect((result as { paid: boolean }).paid).toBe(true);
			expect(onError).toHaveBeenCalledTimes(1);
			expect(onError).toHaveBeenCalledWith(
				error,
				expect.objectContaining({ payer: "0xPayerWallet", request }),
			);
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});

		it("ignores an onError handler that throws", async () => {
			const enforcer = await freshEnforcer({
				...defaultConfig,
				onSettled: () => Promise.reject(new Error("first")),
				onError: () => {
					throw new Error("second");
				},
			});
			mockSuccessfulPayment();

			const result = await enforcer.enforce(paidRequest());
			await flushDeferred();

			expect((result as { paid: boolean }).paid).toBe(true);
		});

		it("hands the hook's promise to waitUntil when available", async () => {
			const waitUntil = vi.fn();
			const onSettled = vi.fn().mockResolvedValue(undefined);
			const enforcer = await freshEnforcer({ ...defaultConfig, onSettled }, { waitUntil });
			mockSuccessfulPayment();

			await enforcer.enforce(paidRequest());

			expect(waitUntil).toHaveBeenCalledTimes(1);
			const [task] = waitUntil.mock.calls[0] as [Promise<unknown>];
			expect(task).toBeInstanceOf(Promise);
			await task;
			expect(onSettled).toHaveBeenCalledTimes(1);
		});

		it("passes a promise that never rejects to waitUntil", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const waitUntil = vi.fn();
			const enforcer = await freshEnforcer(
				{ ...defaultConfig, onSettled: () => Promise.reject(new Error("nope")) },
				{ waitUntil },
			);
			mockSuccessfulPayment();

			await enforcer.enforce(paidRequest());

			const [task] = waitUntil.mock.calls[0] as [Promise<unknown>];
			await expect(task).resolves.toBeUndefined();
			vi.mocked(console.warn).mockRestore();
		});

		it("does not fail the request when waitUntil throws", async () => {
			const onSettled = vi.fn();
			const enforcer = await freshEnforcer(
				{ ...defaultConfig, onSettled },
				{
					waitUntil: () => {
						throw new Error("no request context");
					},
				},
			);
			mockSuccessfulPayment();

			const result = await enforcer.enforce(paidRequest());
			await flushDeferred();

			expect((result as { paid: boolean }).paid).toBe(true);
			expect(onSettled).toHaveBeenCalledTimes(1);
		});

		it("does not call waitUntil when no hook is configured", async () => {
			const waitUntil = vi.fn();
			const enforcer = await freshEnforcer(defaultConfig, { waitUntil });
			mockSuccessfulPayment();

			await enforcer.enforce(paidRequest());

			expect(waitUntil).not.toHaveBeenCalled();
		});
	});

	describe("botOnly mode", () => {
		it("skips enforcement for humans (high bot score)", async () => {
			const enforcer = await freshEnforcer({ ...defaultConfig, botOnly: true });
			const request = makeRequest(
				"https://example.com/article",
				{},
				{ botManagement: { score: 90 } },
			);

			const result = await enforcer.enforce(request);

			expect(result).not.toBeInstanceOf(Response);
			const enforceResult = result as { paid: boolean; skipped: boolean };
			expect(enforceResult.paid).toBe(false);
			expect(enforceResult.skipped).toBe(true);
		});

		it("enforces for bots (low bot score)", async () => {
			const enforcer = await freshEnforcer({ ...defaultConfig, botOnly: true });
			const request = makeRequest(
				"https://example.com/article",
				{},
				{ botManagement: { score: 5 } },
			);

			const mockRequirements = [{ scheme: "exact", network: "eip155:8453" }];
			mockBuildPaymentRequirements.mockResolvedValue(mockRequirements);
			mockCreatePaymentRequiredResponse.mockResolvedValue({
				x402Version: 2,
				accepts: mockRequirements,
			});

			const result = await enforcer.enforce(request);

			expect(result).toBeInstanceOf(Response);
			expect((result as Response).status).toBe(402);
		});

		it("treats missing cf data as human (skips enforcement)", async () => {
			const enforcer = await freshEnforcer({ ...defaultConfig, botOnly: true });
			const request = makeRequest("https://example.com/article");

			const result = await enforcer.enforce(request);

			expect(result).not.toBeInstanceOf(Response);
			const enforceResult = result as { skipped: boolean };
			expect(enforceResult.skipped).toBe(true);
		});

		it("respects custom botScoreThreshold", async () => {
			const enforcer = await freshEnforcer({
				...defaultConfig,
				botOnly: true,
				botScoreThreshold: 50,
			});
			// Score 40 < threshold 50 -> bot -> enforce
			const request = makeRequest(
				"https://example.com/article",
				{},
				{ botManagement: { score: 40 } },
			);

			const mockRequirements = [{ scheme: "exact", network: "eip155:8453" }];
			mockBuildPaymentRequirements.mockResolvedValue(mockRequirements);
			mockCreatePaymentRequiredResponse.mockResolvedValue({
				x402Version: 2,
				accepts: mockRequirements,
			});

			const result = await enforcer.enforce(request);
			expect(result).toBeInstanceOf(Response);
		});
	});

	describe("applyHeaders()", () => {
		it("sets response headers from EnforceResult", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const mockResponse = { headers: new Headers() };

			enforcer.applyHeaders(
				{
					paid: true,
					skipped: false,
					responseHeaders: {
						"PAYMENT-RESPONSE": "encoded-response",
						"X-Custom": "value",
					},
				},
				mockResponse,
			);

			expect(mockResponse.headers.get("PAYMENT-RESPONSE")).toBe("encoded-response");
			expect(mockResponse.headers.get("X-Custom")).toBe("value");
		});

		it("is a no-op when there are no response headers", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const mockResponse = { headers: new Headers() };

			enforcer.applyHeaders({ paid: false, skipped: true, responseHeaders: {} }, mockResponse);

			expect([...mockResponse.headers.entries()]).toHaveLength(0);
		});
	});

	describe("hasPayment()", () => {
		it("returns true when payment-signature header is present", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const request = makeRequest("https://example.com/article", {
				"payment-signature": "some-sig",
			});
			expect(enforcer.hasPayment(request)).toBe(true);
		});

		it("returns true when PAYMENT-SIGNATURE header is present (uppercase)", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const request = makeRequest("https://example.com/article", {
				"PAYMENT-SIGNATURE": "some-sig",
			});
			expect(enforcer.hasPayment(request)).toBe(true);
		});

		it("returns false when no payment header is present", async () => {
			const enforcer = await freshEnforcer(defaultConfig);
			const request = makeRequest("https://example.com/article");
			expect(enforcer.hasPayment(request)).toBe(false);
		});
	});
});
