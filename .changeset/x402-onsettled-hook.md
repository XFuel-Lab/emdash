---
"@emdash-cms/x402": minor
---

Adds an `onSettled` option to the x402 integration so sites can log paid reads, record analytics, issue receipts, or update revenue dashboards whenever a payment settles successfully.

Pass a module reference, since the integration config is serialized into the build:

```js
x402({
	payTo: "0xYourWallet",
	network: "eip155:8453",
	onSettled: { module: "./src/x402-hooks.ts", export: "onSettled" },
});
```

The hook receives the payer, settlement response, matched payment requirements, resource info, and request. It runs after `enforce()` returns and never delays or fails the response: errors are logged with `console.warn`, or passed to an optional `onError` hook. Under the Cloudflare adapter the hook's promise is passed to `waitUntil`. Sites that do not set `onSettled` see no change.
