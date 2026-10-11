import assert from "node:assert/strict";
import { test } from "node:test";
import { assetPaymentSummary } from "../src/interpretation/asset-payment.js";

test("third-party outflow identifies the initiator without inferring recipient ownership", () => {
  assert.deepEqual(
    assetPaymentSummary(
      "Caller",
      [
        { holder: "Holder", direction: "loss", quantity: "8000 Token" },
        { holder: "Recipient", direction: "gain", quantity: "8000 Token" },
      ],
      [{ from: "Holder", to: "Recipient" }],
      "ETH",
    ),
    [
      "initiator (Caller): no net token or ETH movement recorded",
      "Holder: lost 8000 Token; no token or ETH compensation recorded",
      "Recipient: gained 8000 Token; no token or ETH payment recorded",
    ],
  );
});

test("native payment prevents describing a token gain as having no payment", () => {
  const summary = assetPaymentSummary(
    "Caller",
    [
      { holder: "Caller", direction: "gain", quantity: "20 Token" },
      { holder: "Caller", direction: "loss", quantity: "0.1 ETH" },
    ],
    [
      { from: "Caller", to: "Pool" },
      { from: "Pool", to: "Caller" },
    ],
    "ETH",
  );
  assert.deepEqual(summary, [
    "initiator (Caller): gained 20 Token; lost 0.1 ETH",
  ]);
});

test("a refunded payment is not mistaken for no payment, even when net is zero", () => {
  const summary = assetPaymentSummary(
    "Caller",
    [{ holder: "Caller", direction: "gain", quantity: "20 Token" }],
    [
      { from: "Caller", to: "Pool" },
      { from: "Pool", to: "Caller" },
    ],
    "ETH",
  );
  assert.deepEqual(summary, ["initiator (Caller): gained 20 Token"]);
});

test("self-transfers do not count as payment and mint endpoints are not holders", () => {
  const summary = assetPaymentSummary(
    "Caller",
    [{ holder: "Caller", direction: "gain", quantity: "20 units Token" }],
    [
      { from: "Caller", to: "Caller" },
      { from: null, to: "Caller" },
    ],
    "ETH",
  );
  assert.deepEqual(summary, [
    "initiator (Caller): gained 20 units Token; no token or ETH payment recorded",
  ]);
});
