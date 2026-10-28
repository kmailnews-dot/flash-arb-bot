function assertDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimals must be a non-negative integer, got ${decimals}`);
  }
}

function assertTokenUsdPrice(tokenUsdPrice) {
  const price = Number(tokenUsdPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`tokenUsdPrice must be a positive finite number, got ${tokenUsdPrice}`);
  }
  return price;
}

/// Converts a USD amount to token units, rounding up. Throws on a non-finite/negative
/// usdAmount, a tokenUsdPrice <= 0, or invalid decimals (not a non-negative integer).
function usdToTokenUnits({ usdAmount, tokenUsdPrice, decimals }) {
  const usd = Number(usdAmount);
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`usdAmount must be a non-negative finite number, got ${usdAmount}`);
  }
  assertDecimals(decimals);
  const price = assertTokenUsdPrice(tokenUsdPrice);

  const units = (usd / price) * 10 ** decimals;
  if (!Number.isFinite(units)) {
    throw new Error(`usdAmount is too large to convert with decimals ${decimals}`);
  }
  return BigInt(Math.ceil(units));
}

/// Converts token units to a USD Number. Throws on a tokenUsdPrice <= 0 or invalid decimals
/// (not a non-negative integer).
function tokenUnitsToUsd({ tokenUnits, tokenUsdPrice, decimals }) {
  assertDecimals(decimals);
  const price = assertTokenUsdPrice(tokenUsdPrice);
  return (Number(tokenUnits) / 10 ** decimals) * price;
}

module.exports = { usdToTokenUnits, tokenUnitsToUsd };
