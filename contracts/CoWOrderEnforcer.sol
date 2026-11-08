// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Local integration candidate. Not deployed, audited or approved for real funds.
/// Compatible with the DelegationManager v1.3.0 caveat-hook ABI. The manager,
/// settlement code and exact policy must be verified before any owner signs it.
interface ICoWPolicySettlement {
    function preSignature(bytes calldata uid) external view returns (uint256);
    function filledAmount(bytes calldata uid) external view returns (uint256);
}

contract CoWOrderEnforcer {
    struct Market {
        address baseToken;
        uint128 maxBasePerSell;
        uint128 maxBaseTotal;
        uint128 buyFloorQuote;
        uint128 buyFloorBase;
        uint128 sellFloorBase;
        uint128 sellFloorQuote;
    }
    struct Terms {
        uint256 chainId;
        address owner;
        address executor;
        address quoteToken;
        bytes32 orderNamespace;
        uint48 startsAt;
        uint48 expiresAt;
        // Validity is not the strategy cancellation timer. The existing durable
        // scheduler must still arm active cancellation at 60s before submission.
        uint32 maxOrderValiditySeconds;
        uint128 maxQuotePerBuy;
        uint128 maxQuoteTotal;
        Market[] markets;
    }
    struct Order {
        address sellToken;
        address buyToken;
        address receiver;
        uint256 sellAmount;
        uint256 buyAmount;
        uint32 validTo;
        bytes32 appData;
        uint256 feeAmount;
        bytes32 kind;
        bool partiallyFillable;
        bytes32 sellTokenBalance;
        bytes32 buyTokenBalance;
    }

    address public immutable delegationManager;
    address public immutable settlement;
    uint256 public immutable chainId;
    bytes32 public immutable domainSeparator;
    bytes32 private constant ORDER_TYPEHASH = keccak256(
        "Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)"
    );
    bytes32 private constant BUY = keccak256("buy");
    bytes32 private constant SELL = keccak256("sell");
    bytes32 private constant ERC20 = keccak256("erc20");
    bytes4 private constant PRESIGN = bytes4(keccak256("setPreSignature(bytes,bool)"));
    bytes4 private constant CANCEL = bytes4(keccak256("invalidateOrder(bytes)"));

    // These are cumulative authorization caps, not spendable balances, a P&L
    // ledger or the strategy's percentage sizing. They never refund on cancel.
    mapping(bytes32 => uint256) public quoteAuthorized;
    mapping(bytes32 => mapping(address => uint256)) public baseAuthorized;
    mapping(bytes32 => mapping(bytes32 => bool)) public registered;
    mapping(bytes32 => mapping(bytes32 => bool)) public cancelled;
    mapping(bytes32 => mapping(bytes32 => bytes32)) public intentOrder;

    modifier onlyManager() { require(msg.sender == delegationManager, "policy:manager"); _; }

    constructor(address manager, address target, uint256 expectedChainId) {
        require(manager.code.length != 0 && target.code.length != 0, "policy:contracts");
        require(expectedChainId != 0 && block.chainid == expectedChainId, "policy:chain");
        delegationManager = manager; settlement = target; chainId = expectedChainId;
        domainSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Gnosis Protocol"), keccak256("v2"), expectedChainId, target
        ));
    }

    function beforeAllHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external onlyManager { }
    function afterAllHook(bytes calldata, bytes calldata, bytes32, bytes calldata, bytes32, address, address) external onlyManager { }

    function beforeHook(
        bytes calldata encodedTerms, bytes calldata args, bytes32 mode, bytes calldata execution,
        bytes32 delegationHash, address owner, address executor
    ) external onlyManager {
        Terms memory terms = abi.decode(encodedTerms, (Terms));
        validateTerms(terms, owner, executor);
        bytes calldata call = settlementCall(mode, execution);
        if (bytes4(call[:4]) == PRESIGN) {
            (bytes memory uid, bool enabled) = abi.decode(call[4:], (bytes, bool));
            require(enabled, "policy:presign-disable");
            (Order memory order, bytes32 intentKey) = abi.decode(args, (Order, bytes32));
            require(intentKey != bytes32(0) && order.appData == appDataHash(terms.orderNamespace, delegationHash, intentKey), "policy:namespace");
            bytes memory expected = orderUid(order, owner);
            require(keccak256(uid) == keccak256(expected), "policy:uid");
            require(ICoWPolicySettlement(settlement).filledAmount(uid) != type(uint256).max, "policy:invalidated");
            uint256 currentPresign = ICoWPolicySettlement(settlement).preSignature(uid);
            bytes32 key = keccak256(uid);
            bytes32 priorIntent = intentOrder[delegationHash][intentKey];
            require(priorIntent == bytes32(0) || priorIntent == key, "policy:intent-conflict");
            require(!cancelled[delegationHash][key], "policy:cancelled");
            validateOrder(terms, order);
            if (!registered[delegationHash][key]) {
                require(currentPresign == 0
                    && ICoWPolicySettlement(settlement).filledAmount(uid) == 0, "policy:existing-order");
                reserve(terms, order, delegationHash);
                registered[delegationHash][key] = true;
                intentOrder[delegationHash][intentKey] = key;
            } else require(currentPresign != 0, "policy:owner-revoked");
        } else if (bytes4(call[:4]) == CANCEL) {
            require(args.length == 0, "policy:cancel-args");
            bytes memory uid = abi.decode(call[4:], (bytes));
            bytes32 key = keccak256(uid);
            // A delegate cannot cancel a manual/unrelated owner's order.
            require(registered[delegationHash][key], "policy:unknown-order");
            cancelled[delegationHash][key] = true;
        } else revert("policy:selector");
    }

    function afterHook(
        bytes calldata, bytes calldata, bytes32 mode, bytes calldata execution,
        bytes32, address, address
    ) external view onlyManager {
        bytes calldata call = settlementCall(mode, execution);
        if (bytes4(call[:4]) == PRESIGN) {
            (bytes memory uid, bool enabled) = abi.decode(call[4:], (bytes, bool));
            require(enabled && ICoWPolicySettlement(settlement).preSignature(uid) != 0, "policy:not-presigned");
        } else if (bytes4(call[:4]) == CANCEL) {
            bytes memory uid = abi.decode(call[4:], (bytes));
            require(ICoWPolicySettlement(settlement).filledAmount(uid) == type(uint256).max, "policy:not-invalidated");
        } else revert("policy:selector");
    }

    function settlementCall(bytes32 mode, bytes calldata execution) private view returns (bytes calldata call) {
        // ERC-7579 SingleDefault only: address20 || value32 || calldata.
        require(mode == bytes32(0) && execution.length >= 56, "policy:mode");
        require(address(bytes20(execution[:20])) == settlement, "policy:target");
        require(uint256(bytes32(execution[20:52])) == 0, "policy:native-value");
        return execution[52:];
    }

    function validateTerms(Terms memory t, address owner, address executor) private view {
        require(t.chainId == chainId && block.chainid == chainId, "policy:chain");
        require(t.owner == owner && owner != address(0) && t.executor == executor && executor != address(0) && owner != executor, "policy:identity");
        require(t.quoteToken != address(0) && t.startsAt < t.expiresAt && block.timestamp >= t.startsAt && block.timestamp < t.expiresAt, "policy:lifetime");
        require(t.orderNamespace != bytes32(0) && t.maxOrderValiditySeconds >= 60
            && t.maxQuotePerBuy != 0 && t.maxQuotePerBuy <= t.maxQuoteTotal, "policy:caps");
        require(t.markets.length != 0 && t.markets.length <= 30, "policy:markets");
        for (uint256 i; i < t.markets.length; ++i) {
            Market memory m = t.markets[i];
            require(m.baseToken != address(0) && m.baseToken != t.quoteToken, "policy:token");
            require(m.maxBasePerSell != 0 && m.maxBasePerSell <= m.maxBaseTotal, "policy:base-caps");
            require(m.buyFloorQuote != 0 && m.buyFloorBase != 0 && m.sellFloorBase != 0 && m.sellFloorQuote != 0, "policy:price-floor");
            for (uint256 j; j < i; ++j) require(m.baseToken != t.markets[j].baseToken, "policy:duplicate-market");
        }
    }

    function validateOrder(Terms memory t, Order memory o) private view {
        require(o.receiver == t.owner && o.feeAmount == 0 && o.partiallyFillable, "policy:order");
        require(o.sellTokenBalance == ERC20 && o.buyTokenBalance == ERC20, "policy:balance");
        require(o.sellAmount != 0 && o.buyAmount != 0 && o.sellAmount <= type(uint128).max && o.buyAmount <= type(uint128).max, "policy:amount");
        require(o.validTo > block.timestamp && o.validTo <= t.expiresAt && uint256(o.validTo) - block.timestamp <= t.maxOrderValiditySeconds, "policy:validity");
        bool buying = o.sellToken == t.quoteToken;
        require(buying ? o.kind == BUY : o.kind == SELL && o.buyToken == t.quoteToken, "policy:kind");
        address base = buying ? o.buyToken : o.sellToken;
        bool found;
        for (uint256 i; i < t.markets.length; ++i) {
            Market memory m = t.markets[i];
            if (m.baseToken != base) continue;
            found = true;
            if (buying) {
                require(o.sellAmount <= t.maxQuotePerBuy, "policy:buy-cap");
                require(o.buyAmount * uint256(m.buyFloorQuote) >= o.sellAmount * uint256(m.buyFloorBase), "policy:buy-price");
            } else {
                require(o.sellAmount <= m.maxBasePerSell, "policy:sell-cap");
                require(o.buyAmount * uint256(m.sellFloorBase) >= o.sellAmount * uint256(m.sellFloorQuote), "policy:sell-price");
            }
        }
        require(found, "policy:market");
    }

    function reserve(Terms memory t, Order memory o, bytes32 delegationHash) private {
        if (o.sellToken == t.quoteToken) {
            uint256 next = quoteAuthorized[delegationHash] + o.sellAmount;
            require(next <= t.maxQuoteTotal, "policy:quote-total");
            quoteAuthorized[delegationHash] = next;
        } else {
            for (uint256 i; i < t.markets.length; ++i) if (t.markets[i].baseToken == o.sellToken) {
                uint256 next = baseAuthorized[delegationHash][o.sellToken] + o.sellAmount;
                require(next <= t.markets[i].maxBaseTotal, "policy:base-total");
                baseAuthorized[delegationHash][o.sellToken] = next;
            }
        }
    }

    function orderUid(Order memory order, address owner) public view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(ORDER_TYPEHASH,
            order.sellToken, order.buyToken, order.receiver, order.sellAmount, order.buyAmount,
            order.validTo, order.appData, order.feeAmount, order.kind, order.partiallyFillable,
            order.sellTokenBalance, order.buyTokenBalance
        ));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
        return abi.encodePacked(digest, owner, order.validTo);
    }

    function appDataHash(bytes32 orderNamespace, bytes32 delegationHash, bytes32 intentKey) public pure returns (bytes32) {
        // CoW app-data v1.3.0 permits a string appCode and rejects unknown root
        // metadata. Commit exact canonical JSON, not an unresolvable raw hash.
        return keccak256(abi.encodePacked('{"appCode":"mirsad:', hex32(orderNamespace), ':',
            hex32(delegationHash), ':', hex32(intentKey), '","metadata":{},"version":"1.3.0"}'));
    }

    function hex32(bytes32 value) private pure returns (string memory) {
        bytes memory output = new bytes(66);
        bytes16 alphabet = "0123456789abcdef";
        output[0] = "0"; output[1] = "x";
        for (uint256 i; i < 32; ++i) {
            output[2 + i * 2] = alphabet[uint8(value[i]) >> 4];
            output[3 + i * 2] = alphabet[uint8(value[i]) & 15];
        }
        return string(output);
    }
}
