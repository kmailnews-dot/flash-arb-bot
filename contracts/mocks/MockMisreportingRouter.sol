// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouterV3Like} from "../interfaces/ISwapRouterV3Like.sol";

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/// @notice Test-only V3 router that can report an amountOut different from what it actually mints.
contract MockMisreportingRouter is ISwapRouterV3Like {
    uint256 public actualOut;
    uint256 public reportedOut;

    function setAmounts(uint256 actualOut_, uint256 reportedOut_) external {
        actualOut = actualOut_;
        reportedOut = reportedOut_;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256)
    {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        IMintableERC20(params.tokenOut).mint(params.recipient, actualOut);
        require(actualOut >= params.amountOutMinimum, "MOCK_ROUTER_SLIPPAGE");
        return reportedOut;
    }
}
