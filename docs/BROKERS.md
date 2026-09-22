# Broker integration contracts

Verified against official documentation on 22 September 2026, Europe/Berlin. This document describes API contracts and application safeguards; it is not evidence of account access, broker approval, a fill, or a profitable strategy. A local Ed25519 key pair has been prepared, but no broker API credential has been issued or registered. No order was placed, modified, cancelled, or confirmed during this work.

## Capability boundaries

| Capability | Revolut X | IBKR Web API |
| --- | --- | --- |
| Intended account | The crypto exchange account associated with one API key | Explicitly selected, authorized IBKR brokerage account |
| Crypto | Documented exchange API | Product, jurisdiction and account permissions determine availability |
| Stocks | No Revolut stock-trading API established by the X documentation | Supported with contract discovery and appropriate permissions |
| Public prices without credentials | Yes, explicit EEA market-data endpoints | Do not assume subscribed brokerage data is publicly available |
| Retail authentication | API key + Ed25519 signature | Documented default is locally authenticated Client Portal Gateway |
| Paper account | No official Revolut X paper/testnet identified in the reviewed docs | Separate paper username/password, authenticated as that account |
| Create order | Current schema supports market or limit | Instrument-dependent order types; broker replies may require further confirmation |
| TP/SL | Appears in read schemas; creation is not in the reviewed POST contract | Brackets supported subject to contract rules |
| Hosted app implication | Server-side signing; stable egress if key IP restrictions are enabled | Local companion required for Gateway; direct OAuth requires actual granted access |

German Revolut help documents X API key permissions and IP whitelists. IBKR lists Germany among countries from which accounts are available. Neither statement establishes this user's account approval, trading permissions, subscription entitlements, or direct OAuth eligibility. Sources: [Revolut Germany API help](https://help.revolut.com/en-DE/help/wealth/cryptocurrencies/crypto-exchange/api-trading/question-what-api-does-revolut-x-provide/), [IBKR countries](https://brokerage.ibkr.com/en/accounts/open-account-country-list.php), [IBKR getting started](https://www.interactivebrokers.com/docs/web-api/getting-started).

## Revolut X: authoritative contract

Use the [current reference](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange) and its [OpenAPI YAML](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange.yml). The official [engineering repository](https://github.com/revolut-engineering/revolut-x-api) is supplementary. Some introductory signing examples still contain a different `/crypto-exchange/orders` path and old payload names; the adapter follows the current endpoint schemas instead.

### Authentication

Production origin: `https://revx.revolut.com`. Request paths below include `/api`.

For private endpoints, supply:

```text
X-Revx-API-Key: <API key>
X-Revx-Timestamp: <Unix epoch milliseconds as a decimal string>
X-Revx-Signature: <Base64 Ed25519 signature>
Content-Type: application/json
```

Construct UTF-8 signing bytes with **no added separators**:

```text
timestamp + uppercaseMethod + path + queryWithoutQuestionMark + exactBody
```

`path` includes `/api`. The encoded query and its parameter ordering must match the URL actually sent. An empty query contributes an empty string. GET has an empty body. Serialize a JSON request once, sign those exact bytes, and transmit those bytes. Sign with Ed25519 directly, not a separate SHA prehash:

```ts
import { createPrivateKey, sign } from 'node:crypto';

// Illustrative, side-effect-free signing; this does not send a request.
function signedHeaders(apiKey: string, privateKeyPem: string,
  method: string, path: string, query: URLSearchParams, body = '') {
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path + query.toString() + body;
  return {
    'X-Revx-API-Key': apiKey,
    'X-Revx-Timestamp': timestamp,
    'X-Revx-Signature': sign(null, Buffer.from(message, 'utf8'),
      createPrivateKey(privateKeyPem)).toString('base64'),
    'Content-Type': 'application/json',
  };
}
```

The user later supplies their private PEM securely; only its public key belongs in broker registration. X offers read-only and full-trading key permissions and an IP whitelist. A valid signature alone does not prove write permission. Do not confuse this with Business/Merchant sandbox authentication or their headers. Source: [X authentication and API reference](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange), [key permissions](https://help.revolut.com/en-DE/help/wealth/cryptocurrencies/crypto-exchange/api-trading/question-what-api-does-revolut-x-provide/).

### Read endpoints and interpretation

| Method and path | Response / important parameters |
| --- | --- |
| `GET /api/1.0/balances` | **Bare array** of `currency`, `available`, `reserved`, `total`, optional `staked`; amounts are strings |
| `GET /api/1.0/public/configuration/currencies?region=EEA` | Object keyed by currency; `scale`, `asset_type`, `status` |
| `GET /api/1.0/public/configuration/pairs?region=EEA` | Object keyed by pair; use returned `base` and `quote` to form `BASE-QUOTE` |
| `GET /api/1.0/public/tickers?symbols=BTC-EUR&region=EEA` | `{data:[ticker],metadata:{timestamp}}`; each public ticker has `region` |
| `GET /api/2.0/public/order-book/BTC-EUR?limit=50&region=EEA` | `{data:{asks,bids},metadata:{region,timestamp}}`; levels have `price`, `quantity`, `count`; depth 1–192 |
| `GET /api/1.0/public/candles/BTC-EUR?interval=15&region=EEA` | `{data:[{start,open,high,low,close,volume}],metadata:{region,timestamp}}` |
| `GET /api/1.0/orders/active` | `{data:[order],metadata:{next_cursor?,timestamp}}`; `limit` up to 300 |
| `GET /api/1.0/orders/historical` | Same pagination; `start_date`, `end_date` in ms; `limit` up to 1900 |
| `GET /api/1.0/orders/{venueOrderId}` | `{data:orderDetails}`; includes fee information when available |
| `GET /api/1.0/orders/fills/{venueOrderId}` | `{data:[clientTrade]}` |
| `GET /api/1.0/trades/private/{symbol}` | Paginated executions for one pair; time/cursor filters |
| `GET /api/1.0/transactions` | Paginated account transactions; preserve their statuses and currencies |

Public data is explicitly regional: always request EEA for this integration. Configuration/tickers without a region can include more than one region. Public candle intervals, in minutes: `1,5,15,30,60,240,1440,2880,5760,10080,20160,40320`. `since`/`until` are milliseconds; without `since`, at most 1000 public candles preceding `until` are returned. A zero-volume candle can use midprices. Compute period completion from the interval ending before both server snapshot time and observation time; a quoted price is not itself a completed candle. Source: [public endpoint schemas](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange.yml).

Ticker numbers are decimal strings: `bid`, `ask`, `mid`, `last_price`, `low_24h`, `high_24h`, `price_change_24h`, `volume_24h`, `quote_volume_24h`. `price_change_24h` is an absolute price change, not a percentage. Keep source and reception timestamps separately. For books, calculate best ask as minimum ask and best bid as maximum bid rather than assuming array sort order. An absent, stale, crossed, or invalid book cannot justify submission.

Validate current pair `status`, `base_step`, `quote_step`, `min_order_size` (base units), `max_order_size` (base), and `min_order_size_quote`. Currency scale and pair increments are different constraints. Never hardcode a EUR 10 minimum, round a budget upward, or spend `total` when only `available` is free. A missing fee is unknown, not zero. Source: [pair and balance schemas](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange.yml).

**Observed discrepancy:** the root agent's real public-only check at **2026-09-21 23:26:21 UTC** returned 385 EEA instruments and a BTC-EUR `min_order_size_quote` of `0.1`. The current German Trading Rules Annex 1 says a minimum of **1 quote-currency unit** and maximum of **1,000,000 quote-currency units**. Until actual account rules are clarified, the application should enforce the stricter EUR 1 minimum for EUR pairs, the stricter applicable maximum, and all returned base constraints. Preserve and display the raw feed minimum separately; do not claim the discrepancy is resolved or that an order was accepted. Source: [German X trading rules, Annex 1](https://www.revolut.com/en-DE/legal/crypto-exchange-trading-rules/).

### Order submission contract

`POST /api/1.0/orders` accepts exactly one `limit` or `market` configuration; inside it, exactly one `base_size` or `quote_size`. `side` is lowercase. `client_order_id` is a UUID documented for idempotency. This example is a payload construction example, not an executable recommendation or an order that was submitted:

```json
{
  "client_order_id": "ab9fbd19-b752-4371-9779-5f7e42ccb295",
  "symbol": "BTC-EUR",
  "side": "buy",
  "order_configuration": {
    "limit": {
      "base_size": "0.0001",
      "price": "75000.00",
      "time_in_force": "gtc"
    }
  }
}
```

For market orders the configuration is, for example, `{"market":{"base_size":"0.0001"}}`. Create-limit `time_in_force` supports `gtc` or `ioc`; optional `execution_instructions` can include `post_only`. Do not infer that all read-order TIFs or TP/SL/TWAP types are creatable. The adapter exposes only market and GTC limit using **base quantity**. It does not implement post-only, quote-sized submission, replacement, cancellation, TP/SL creation, or autonomous exits.

**Lifetime wording audit:** `MarketOrderConfiguration` has only `base_size`/`quote_size`; it neither accepts `time_in_force` nor establishes an IOC default in the reviewed schema. Market summaries therefore say **broker default** instead of asserting IOC. Limit summaries remain GTC because the adapter explicitly sends `time_in_force:"gtc"`. The German rules explain immediate matching and possible execution across several book levels, but that does not establish a specific market-order TIF. Sources: [current configuration schema](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange.yml), [German order rules, sections 9–12](https://www.revolut.com/en-DE/legal/crypto-exchange-trading-rules/).

The successful submission body is `{data:{venue_order_id,client_order_id,state}}`; an acknowledgment is not an execution. Order states are `pending_new`, `new`, `partially_filled`, `filled`, `cancelled`, `rejected`, `replaced`. Read details report `filled_quantity`, `filled_amount`, `average_fill_price`, and optional `total_fee`/`fee_currency`. Quantity can be absent for some buy-TWAP orders. Partial fills remain real after cancellation. Source: [create and order schemas](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange.yml).

Other documented mutations, deliberately absent from this adapter: `PUT /api/1.0/orders/{venueOrderId}` replaces an order and changes the venue ID; `DELETE /api/1.0/orders/{venueOrderId}` cancels one; `DELETE /api/1.0/orders` cancels all. These are consequential actions and are not connection tests.

### Reconciliation and pacing

Persist one `client_order_id` per exact user-approved intent before submission. On timeout, malformed acknowledgment, HTTP 5xx or conflict, mark outcome **UNKNOWN**, preserve IDs, and reconcile rather than issue a new order. There is no direct client-ID lookup endpoint in the reviewed schema: inspect paginated active and historical records. A missing match in one pass is not proof the exchange rejected a request. Once venue ID is known, fetch its details and fills. Preserve replacement linkage.

Fill fields include `tid` (unique execution identifier), `oid`, `tdt` (milliseconds), `p`, `q`, `pc` (quote currency), `qc` (base currency), optional `s`, and `im` (maker). Dedupe by `tid`; do not double-count order cumulative quantities and individual fills. Fees come from order details and are not present in the reviewed fill schema. Buy filled quantity and sell filled quote amount can be gross of fees. Source: [execution schemas](https://developer.revolut.com/docs/api/revolut-x-crypto-exchange.yml).

The reviewed public endpoints allow one request/second. Balances and order-fills allow 100/second and 1000/minute. Create order allows 10/second and **1000/day**. Other endpoints have individual token rules; consult their current endpoint definition. Revolut's `Retry-After` is **milliseconds**. A shared limiter/cache is needed across serverless instances; the adapter's in-process public pacing is insufficient globally.

### Implemented adapter contract

`src/lib/brokers/revolut.ts` exports:

```ts
new RevolutXClient({apiKey, privateKey, fetchImpl?})
client.accountId // literal 'revolut-x'
client.getBalances(): Promise<RevolutBalance[]>
client.getOrders(): Promise<RevolutOrder[]>
client.getFills(orderId?: string): Promise<RevolutFill[]>
client.getFillsForOrders(orders: RevolutOrder[], maxOrders = 20): Promise<{fills: RevolutFill[]; truncated: boolean}>
client.getOrder(id: string): Promise<RevolutOrder>
client.findOrderByClientId(clientId: string): Promise<RevolutOrder | null>
client.submitOrder({clientOrderId, symbol, side, type, quantity, limitPrice?}): Promise<RevolutOrder>
getPublicInstruments(fetchImpl?): Promise<RevolutInstrument[]>
getPublicMarket(symbol, interval = 15, fetchImpl?): Promise<RevolutMarket>
```

Decimal values stay strings. `RevolutOrder.quantity` is nullable; ISO `createdAt` and `updatedAt` come from exchange timestamps. `getOrders` reads both active and historical pages, with a 20-page bound per stream and an explicit `INCOMPLETE_HISTORY` error instead of truncation. No-argument `getFills` walks orders with fills; use the order-specific form for efficient incremental reconciliation. Full histories are not necessarily atomic snapshots.

The dashboard should call `getFillsForOrders` with its already-fetched orders. This avoids repeating order scans and reads only the latest 20 filled orders by `updatedAt` by default. `truncated=true` explicitly means partial coverage. Do not calculate lifetime average cost or realized P&L from that partial set. A request bound does not guarantee a latency bound if the broker is slow; show unavailable/pending history rather than fabricated fills.

Each request attempt has a 10-second timeout. Private GETs retry temporary transport/server failures at most twice; public GETs do not retry rapidly. HTTP 429 is explicit `BrokerApiError` with `code='RATE_LIMIT'` and optional `retryAfterMs`. POST never retries. `BrokerUnknownOutcomeError` has `code='UNKNOWN'`, `clientOrderId`, optional `venueOrderId`, and `acknowledged`. If POST was acknowledged but details cannot be fetched, it preserves the venue ID and `acknowledged=true` without fabricating a filled quantity. It does not enforce app authentication, available funds, instrument limits, or user confirmation: those belong to the calling engine.

## IBKR: architecture and authentication

IBKR's retail quick start requires a funded IBKR Pro account, Java, Client Portal Gateway, and browser login. The documented local base is `https://localhost:5000/v1/api`; Gateway handles brokerage authentication for local requests. Its limitations require the browser login and API calls on the same computer as Gateway. `/gw/api`, `/oauth`, and `/oauth2` are not routed by Gateway. Sources: [retail quick start](https://www.interactivebrokers.com/docs/web-api/api/web-api/quick-start), [Gateway installation](https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/installation-authentication), [Gateway request requirements](https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/request-requirements), [Gateway limitations](https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/limitations-of-the-client-portal-gateway).

A Vercel invocation cannot reach the user's `localhost`. For retail Gateway integration, a local companion must make the broker calls on that computer after the user logs in, then exchange authenticated application messages with the hosted UI. Do not expose Gateway directly to the public internet, remotely reuse its cookie as a shortcut, store the user's brokerage password, automate MFA, or disable TLS validation globally. The default Gateway certificate is self-signed; use a properly trusted local certificate configuration. This is an architectural implication of the documented Gateway constraints.

The alternative direct base is `https://api.ibkr.com/v1/api`, with the auth method actually granted to the integration. OAuth 2 documentation describes a registered client signing a `private_key_jwt` assertion with RSA-SHA256, obtaining an access token, exchanging it for an SSO bearer token, and using the latter for brokerage requests. This is **not Revolut Ed25519** and not permission to assume an arbitrary retail account already has OAuth access. Generic endpoint samples display a Bearer header even with the Gateway host; follow Gateway's authentication workflow for that mode. Sources: [OAuth 2 introduction](https://www.interactivebrokers.com/docs/web-api/authentication/oauth-2/introduction), [access token](https://www.interactivebrokers.com/docs/web-api/authentication/oauth-2/access-token), [authenticated requests](https://www.interactivebrokers.com/docs/web-api/authentication/oauth-2/authenticated-requests).

The username has only one brokerage session across IBKR platforms. `/iserver` market/trade functions need that session; some non-`/iserver` portfolio functions can use the outer read-only session. `POST /iserver/auth/ssodh/init` accepts JSON `{"publish":true,"compete":false}`; `compete:true` displaces another session and must not be enabled silently. Keep-alive and reauthentication must respect actual session state. Sources: [sessions](https://www.interactivebrokers.com/docs/web-api/trading/trading-sessions-in-the-web-api), [initialize session](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-session/initialize-session).

### IBKR read and preview endpoints

All paths here are relative to `/v1/api` in the authenticated mode.

| Method and path | Contract / use |
| --- | --- |
| `GET /iserver/accounts` | Discover allowed trading accounts; required before market-data snapshot |
| `GET /portfolio/accounts` | Portfolio account discovery before dependent portfolio reads |
| `GET /portfolio/{accountId}/ledger` | Currency ledgers, cash balances, settled cash and account values |
| `GET /portfolio/{accountId}/summary` | Account portfolio summary |
| `GET /portfolio/{accountId}/positions/{pageId}` | Paginated positions |
| `GET /iserver/secdef/search?symbol=AAPL` | Resolve candidate contracts; verify identity, currency and exchange |
| `GET /iserver/contract/{conid}/info-and-rules` | Instrument detail and rules; follow-up can supply additional rules |
| `POST /iserver/contract/rules` | Read rules with JSON `{"conid":265598,"isBuy":true}`; this POST does not submit an order |
| `GET /iserver/marketdata/snapshot?conids=265598&fields=31,84,86,85,88,6509` | Prime data subscription, then request subsequent available fields |
| `GET /iserver/marketdata/history?conid=265598&period=1d&bar=15min&outsideRth=false&source=Last` | Historical bars with data availability metadata |
| `GET /iserver/account/orders` | Working orders and orders completed/cancelled in the current session |
| `GET /iserver/account/order/status/{orderId}` | Current-session order status; prior-session queries may return 503 |
| `GET /iserver/account/trades?days=7` | Up to seven prior days of executions; default is current day |
| `POST /iserver/account/{accountId}/orders/whatif` | Preview of commission/cost/margin effects using the order wrapper |

Sources: [currency balances](https://www.interactivebrokers.com/docs/web-api/trading/portfolio-and-positions/querying-currency-balances), [search](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-contracts/get-contract-symbols), [instrument/rules](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-contracts/get-info-and-rules), [rules request](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-contracts/get-contract-rules), [snapshot](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-market-data/get-md-snapshot), [history](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-market-data/get-md-history), [orders](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-orders/get-open-orders), [single status](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-orders/get-order-status), [executions](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-orders/get-trade-history), [preview](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-orders/preview-margin-impact).

Snapshot field `31` is last, `84` bid, `86` ask, `85` ask size, `88` bid size, `6509` data availability. The first snapshot can return only initialization information; absent values are not zero. Last can have prefixes such as `C` (previous close) or `H` (halt). Show subscription/real-time/delayed/frozen status. Historical `source=Last`, `Bid_Ask`, and `Midpoint` have different meanings, so do not call midpoint or bid/ask bars executed-trade candles. Preserve their timestamps and `mdAvailability`.

Rules expose order types, fractional types (`fraqTypes`), cash-quantity types (`cqtTypes`), `sizeIncrement`, `fraqInt`, `cashQtyIncr`, and price increments, among other fields. No universal EUR minimum follows from these docs. Ask the broker preview for the actual contract/account, validate permissions and trading hours, and retain the result. A ledger's `BASE` row is an aggregation, not another independent currency balance to sum.

### IBKR submission and replies

The current create endpoint is `POST /iserver/account/{accountId}/orders`. JSON is an **object containing an `orders` array**. Only one order ticket is ordinarily submitted per request except supported brackets. This example constructs a basic stock-limit payload; its contract ID and price are illustrative and must be resolved and reviewed:

```json
{
  "orders": [{
    "conid": 265598,
    "cOID": "manual-20260922-example-001",
    "orderType": "LMT",
    "side": "BUY",
    "tif": "DAY",
    "quantity": 1,
    "price": 100,
    "outsideRTH": false
  }]
}
```

`cOID` is at most 64 characters and must be unique for 24 hours. Bracket children use `parentId` matching the parent's `cOID`; do not set child `cOID` blindly. Broker acknowledgment can report `PreSubmitted`, which is not a fill. The response may instead be an error, an advanced rejection, or an array of questions with `id` and `message`. Source: [submit contract](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-orders/submit-new-order).

`POST /iserver/reply/{replyId}` with `{"confirmed":true}` can continue and place the order. In this manual application, display each broker question and require a fresh explicit user action for that exact reply. Do not auto-confirm or suppress messages. A `whatif` request is only a preview and does not remove subsequent execution warnings. Source: [reply contract](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-orders/confirm-order-reply).

Reconcile by persisted account ID, contract ID, local `cOID`, acknowledged `order_id`, current orders/status, and execution history. Execution `order_ref` corresponds to submitted `cOID`, and `execution_id` identifies fills. The current list-open-orders schema does not promise an `order_ref` field, so do not rely on it universally. `force=true` clears the orders cache and can return an empty array; an ordinary follow-up is needed, not a conclusion that there are no orders. A current-session status 503 does not prove an older order never existed. Keep a durable local history; the short broker endpoints do not reconstruct an unlimited ledger. Sources: [orders](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-orders/get-open-orders), [status](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-orders/get-order-status), [executions](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-orders/get-trade-history).

Treat `cOID` as a correlation/uniqueness constraint, not a documented guarantee that repeating a POST cannot trade twice. Unknown submission outcomes require reconciliation. Modification is `POST /iserver/account/{accountId}/order/{orderId}` and cancellation is `DELETE` at that path; neither is implemented as a connection test. Pending cancellation can still fill. Source: [modify contract](https://www.interactivebrokers.com/docs/web-api/api-reference/trading/trading-orders/modify-open-order).

### IBKR paper mode and current documentation drift

Paper trading uses a **separate paper username and password**. There is no live/paper login slider for the Web API. A local `paper:true` flag or an arbitrary sandbox hostname is not proof of paper login. Generic new endpoint schemas list a QA sandbox server; that is not evidence this retail user has access to it. Keep live and paper identity/configuration distinct and visibly verified. Source: [paper authentication](https://www.interactivebrokers.com/docs/web-api/authentication/paper).

The dated [9 September 2026 changelog](https://www.interactivebrokers.com/docs/web-api/changelog/2026/9/9) supersedes older details: `/iserver/marketdata/history` is capped at 10 requests/second or 50/minute, `/hmds/scanner` is removed, and `secType` is deprecated/removed from `/iserver/secdef/search`. The generated search endpoint page still lists `secType`; omit it in new clients. The [2026 changelog](https://www.interactivebrokers.com/docs/web-api/changelog) also records stock `cashQty` support from 27 March and ten-minute SMD subscription renewal from 14 April. Contract-specific cash/fractional restrictions still apply.

Gateway is documented at 10 requests/second globally; orders/trades polling has tighter endpoint limits (legacy overview lists one per five seconds). Use conservative endpoint-aware pacing, honor 429, and verify current negotiated limits rather than taking the highest number from another IBKR API product. Source: [IBKR Web API pacing overview](https://www.interactivebrokers.com/campus/ibkr-api-page/webapi-doc/).

## Hosted application requirements

Keep broker credentials, signatures, tokens, balances and order histories out of browser storage, service-worker caches, logs and public API responses. Routes require app authentication and server-side authorization for the selected account. Bind each final confirmation to the exact serialized order, connection identity, current validation, and expiry. Atomically consume it before one submission; a refresh, duplicate click, delayed worker, restored draft or HTTP retry must not resubmit. Expired/UNKNOWN requests require review and reconciliation, not automatic replacement.

These application design requirements derive from this task's manual-decision scope. The low-level Revolut adapter deliberately accepts injected credentials and has no DB/environment access. The engine must validate funds, size increments, supported capabilities, stale quotes, price/currency units and risk before calling it. Price monitoring or model output must never call the submission path.

Vercel ordinary egress is not a stable broker allowlist. [Static IPs](https://vercel.com/docs/networking/static-ips) is available on eligible paid plans and provides regional shared egress addresses; [the allowlisting guide](https://vercel.com/kb/guide/how-to-allowlist-deployment-ip-address) also describes dedicated Secure Compute. Configure actual assigned addresses if using Revolut's IP whitelist; no addresses were enabled or purchased here. Store approval/nonces/reconciliation state durably with atomic database operations, not module variables or local files.

Function invocations are finite: current Fluid limits are 300 seconds on Hobby and normally up to 800 seconds on Pro/Enterprise, with a documented extended beta under conditions. This does not provide an always-running brokerage session on the user's computer. Do not claim that a hosted route maintains Gateway indefinitely. Vercel now documents WebSocket features in beta, so the obsolete blanket statement that it has no WebSocket support should not guide architecture. Sources: [function limitations](https://vercel.com/docs/functions/limitations), [Gateway machine constraint](https://www.interactivebrokers.com/docs/web-api/authentication/cpgw/limitations-of-the-client-portal-gateway).

## Verification performed and remaining checks

### Scripted partial-fill accounting audit and fix

The isolated simulator previously deducted only the filled quantity and set `available=total` while leaving the order `PARTIALLY_FILLED`. That made its unfilled commitment spendable again. This has been fixed in `services.ts`: partial buys reserve the remaining quote amount plus the modeled 0.09% fee; partial sells reserve the remaining base quantity. The balance lock protects settlement, and settlement independently rejects any new order that would consume existing reservations. Dashboard and trading-context balances expose `reserved`, `total`, and `available=total-reserved`.

The deterministic reproduction uses **artificial** prices, no broker/network calls, and an in-memory database:

1. Start with virtual EUR 10,000 and zero BTC. Submit the scripted partial scenario for a limit buy of 90 BTC at the fixture price EUR 100.
2. The script fills 45 BTC: EUR 4,500 notional plus EUR 4.05 fee. The remaining total cash is EUR 5,495.95.
3. The unfilled 45 BTC requires EUR 4,504.05 reserved, including the modeled remaining fee. Spendable cash is therefore **EUR 991.90**, not EUR 5,495.95.
4. A second full buy of 40 BTC would require EUR 4,003.60. Previously it could consume the first order's commitment; now both validation and transactional settlement reject it.
5. For a partial sell of 90 BTC starting with 100 BTC, 45 BTC fills, 45 BTC remains reserved, and only 10 of the remaining 55 BTC is available to sell.

`tests/simulation.test.ts` runs these scenarios against the actual simulation service with cached artificial market fixtures and a hard network prohibition. It also checks cumulative reservations, repeated-order idempotency, full-fill balances and reconstruction of reservations for older stored partial orders. Reconstruction retains actual totals; it does not invent cash or reset a legacy portfolio. If old activity already overcommitted funds, available funds may become negative, visibly blocking further spending rather than concealing the deficit.

This remains a **scripted order-state simulator**, not a live matching-engine model: choosing the partial scenario assigns a half fill, including for an unmarketable limit, and the remainder stays reserved without automatic later execution or cancellation. The script does not validate live fill probability, slippage, liquidity, or strategy returns. A future simulator with lifecycle transitions must release or consume the stored reservation atomically with each cancellation/fill.

- TypeScript passed after the adapter was added.
- An in-memory, unregistered Ed25519 test key verified a mocked GET signature and balance normalization. No live key or real account was used.
- Mocked public data verified that an unfinished candle remains incomplete and a zero-volume candle is flagged as potentially using midprices.
- `tests/brokers.test.ts`: 15 isolated mock-transport tests passed, including exact Ed25519 request signing, single POST, ambiguous outcomes, acknowledged-but-unreadable details, explicit 429 milliseconds, bounded GET retry, pagination/cursor encoding, duplicate reconciliation, nullable quantities, limited fill coverage and EEA data interpretation. Submission methods in these tests only call injected mocks; no real requests are made.
- The root agent verified real **public** endpoints at 2026-09-21 23:26:21 UTC: 385 EEA instruments, BTC-EUR ticker and 1000 candles. This does not verify a private account or trading permission.
- The private account APIs, key permissions, real fills, brokerage fees, deployed egress and IBKR connection remain unverified until the user connects authorized accounts through the intended setup flow. No scopes/permissions introspection endpoint was identified in the reviewed X schema. A successful balances GET therefore cannot justify a label of verified trading permission.


