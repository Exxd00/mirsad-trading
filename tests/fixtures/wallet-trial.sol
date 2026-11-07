// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Local-chain fixtures. The router uses a fixed artificial exchange rate.
contract TrialToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    function mint(address to, uint256 value) external { balanceOf[to] += value; emit Transfer(address(0), to, value); }
    function approve(address spender, uint256 value) external returns (bool) { allowance[msg.sender][spender] = value; return true; }
    function transfer(address to, uint256 value) external returns (bool) { move(msg.sender, to, value); return true; }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value; move(from, to, value); return true;
    }
    function move(address from, address to, uint256 value) private {
        balanceOf[from] -= value; balanceOf[to] += value; emit Transfer(from, to, value);
    }
}
contract TrialRouter {
    address immutable quote;
    constructor(address initialQuote) { quote = initialQuote; }
    struct Swap { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    struct Quote { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }
    function out(address token, uint256 amount) private view returns (uint256) {
        return token == quote ? amount * 500_000_000 : amount / 500_000_000;
    }
    function quoteExactInputSingle(Quote calldata q) external view returns(uint256,uint160,uint32,uint256) {
        return (out(q.tokenIn,q.amountIn),0,0,0);
    }
    function exactInputSingle(Swap calldata p) external payable returns (uint256 amountOut) {
        amountOut = out(p.tokenIn,p.amountIn); require(p.fee == 500 && amountOut >= p.amountOutMinimum);
        TrialToken(p.tokenIn).transferFrom(msg.sender,address(this),p.amountIn);
        TrialToken(p.tokenOut).transfer(p.recipient,amountOut);
    }
}
