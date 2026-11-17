const { ethers } = require("ethers");
const { V2_ROUTER_ABI, V3_QUOTER_ABI } = require("./abis");

// Contract instances are immutable and cheap to reuse. Caching them per provider avoids
// rebuilding an Interface and re-resolving the network on every quote.
const v2Contracts = new WeakMap();
const v3Contracts = new WeakMap();

function cachedContract(cache, provider, address, abi) {
  let byAddress = cache.get(provider);
  if (!byAddress) {
    byAddress = new Map();
    cache.set(provider, byAddress);
  }
  let contract = byAddress.get(address);
  if (!contract) {
    contract = new ethers.Contract(address, abi, provider);
    byAddress.set(address, contract);
  }
  return contract;
}

/// Quotes a V2-style router (SushiSwap, Camelot V2, ...): amountIn of tokenIn -> tokenOut.
async function quoteV2(provider, routerAddress, tokenIn, tokenOut, amountIn, blockTag = "latest") {
  const router = cachedContract(v2Contracts, provider, routerAddress, V2_ROUTER_ABI);
  const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut], { blockTag });
  return amounts[amounts.length - 1];
}

/// Quotes Uniswap V3's QuoterV2 for a single-hop exactInput swap.
async function quoteV3(
  provider,
  quoterAddress,
  tokenIn,
  tokenOut,
  fee,
  amountIn,
  blockTag = "latest"
) {
  const quoter = cachedContract(v3Contracts, provider, quoterAddress, V3_QUOTER_ABI);
  const result = await quoter.quoteExactInputSingle.staticCall(
    {
      tokenIn,
      tokenOut,
      amountIn,
      fee,
      sqrtPriceLimitX96: 0n,
    },
    { blockTag }
  );
  return result.amountOut;
}

/// Dispatches to quoteV2/quoteV3 based on a leg's `kind` ("V2" | "V3").
///
/// Note: for a V3 leg, `leg.router` is the SwapRouter used to *execute* the swap on-chain, but
/// Uniswap V3's SwapRouter does not itself expose a view-quoting function - quoting requires the
/// separate QuoterV2 contract. So V3 legs must also set `leg.quoter` to that address; V2-style
/// routers expose getAmountsOut directly, so no separate quoter is needed there.
async function quoteLeg(provider, leg, tokenIn, amountIn, blockTag = "latest") {
  if (leg.kind === "V2") {
    return quoteV2(provider, leg.router, tokenIn, leg.tokenOut, amountIn, blockTag);
  }
  if (leg.kind === "V3") {
    if (!leg.quoter) {
      throw new Error(
        `V3 leg for router ${leg.router} is missing "quoter" - set it to the Uniswap V3 QuoterV2 address.`
      );
    }
    return quoteV3(provider, leg.quoter, tokenIn, leg.tokenOut, leg.v3Fee, amountIn, blockTag);
  }
  throw new Error(`Unknown leg kind: ${leg.kind}`);
}

module.exports = { quoteV2, quoteV3, quoteLeg };
