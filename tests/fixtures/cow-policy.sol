// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Isolated policy fixture only. It does not execute trades or price any assets.
contract PolicySettlementFixture {
    mapping(bytes => uint256) public preSignature;
    mapping(bytes => uint256) public filledAmount;
    bool public omitExecution;
    function setOmitExecution(bool value) external { omitExecution = value; }
    function owner(bytes calldata uid) private pure returns(address) {
        require(uid.length == 56, "fixture:uid");
        return address(bytes20(uid[32:52]));
    }
    function setPreSignature(bytes calldata uid, bool enabled) external {
        require(msg.sender == owner(uid), "fixture:owner");
        if (!omitExecution) preSignature[uid] = enabled ? 1 : 0;
    }
    function invalidateOrder(bytes calldata uid) external {
        require(msg.sender == owner(uid), "fixture:owner");
        if (!omitExecution) filledAmount[uid] = type(uint256).max;
    }
    function simulatePartialFill(bytes calldata uid, uint256 amount) external {
        require(preSignature[uid] != 0 && filledAmount[uid] != type(uint256).max, "fixture:closed");
        filledAmount[uid] += amount;
    }
}
