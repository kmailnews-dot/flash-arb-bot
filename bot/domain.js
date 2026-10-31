/**
 * Jeton ERC-20 manipulé par le bot.
 * @typedef {Object} Token
 * @property {string} address
 * @property {number} decimals
 * @property {string} [symbol]
 * @property {boolean} [isStable]
 * @property {boolean} [isWeth]
 */

/**
 * Jambe de swap d'une paire, V2 ou V3.
 * @typedef {Object} Leg
 * @property {"V2"|"V3"} kind
 * @property {string} router
 * @property {string} tokenOut
 * @property {number} [v3Fee]
 * @property {string} [quoter]
 */

/**
 * Paire de tokens et route de swap aller-retour.
 * @typedef {Object} Pair
 * @property {string} [label]
 * @property {Token} borrowedToken
 * @property {Token} intermediateToken
 * @property {Leg} legOut
 * @property {Leg} legBack
 * @property {string[]} tradeSizes
 */

/**
 * Résultat d'un scan pour une taille de trade donnée.
 * @typedef {Object} Opportunity
 * @property {Pair} pair
 * @property {string} tradeSizeHuman
 * @property {string} quoteTimestamp
 * @property {bigint|null} gasPriceWei
 * @property {number|null} ethUsdPrice
 * @property {bigint} amountIn
 * @property {bigint} intermediateOut
 * @property {bigint} finalOut
 * @property {bigint} premium
 * @property {bigint} owed
 * @property {bigint} grossProfit
 * @property {number|null} grossProfitUsd
 * @property {number|null} gasCostUsd
 * @property {number|null} netProfitUsd
 * @property {boolean} priced
 * @property {boolean} isOpportunity
 */

/**
 * Données de frais retournées par le provider ethers.
 * @typedef {Object} FeeData
 * @property {bigint|null} gasPrice
 * @property {bigint|null} maxFeePerGas
 * @property {bigint|null} maxPriorityFeePerGas
 */

/**
 * Résultat du re-quote des deux jambes juste avant l'exécution.
 * @typedef {Object} ReQuote
 * @property {bigint} intermediateOutFresh
 * @property {bigint} finalOutFresh
 * @property {bigint} grossProfitFresh
 * @property {bigint} premiumFresh
 * @property {bigint} owedFresh
 */

/**
 * Frais de transaction prêts à être envoyés.
 * @typedef {Object} Pricing
 * @property {bigint} [maxFeePerGas]
 * @property {bigint} [maxPriorityFeePerGas]
 * @property {bigint} [gasPrice]
 */

/**
 * Décision de soumettre ou non une opportunité.
 * @typedef {Object} Decision
 * @property {boolean} shouldExecute
 * @property {string} reason
 * @property {Opportunity} opportunity
 * @property {bigint} effectiveGrossProfit
 * @property {bigint|null} gasCostInToken
 * @property {bigint|null} gasFloor
 * @property {bigint|null} netProfitFresh
 * @property {bigint|null} netProfit
 * @property {number|null} netProfitUsd
 * @property {bigint|null} netProfitBps
 * @property {bigint|null} maxFeeCostInToken
 * @property {bigint} decisionGasPriceWei
 * @property {bigint} gasLimitWithMargin
 * @property {bigint} gasCostWei
 * @property {bigint|null} freshGrossProfit
 * @property {bigint} estimatedGas
 * @property {bigint|null} gasPriceWei
 * @property {Pricing} feeOverrides
 */

/**
 * Résultat d'une tentative d'exécution.
 * @typedef {Object} ExecutionResult
 * @property {boolean} submitted
 * @property {string} [error]
 * @property {string} [guard]
 * @property {boolean} [simulated]
 * @property {bigint} [estimatedGas]
 * @property {bigint} [gasLimitWithMargin]
 * @property {string} [txHash]
 * @property {Object} [receipt]
 */

/**
 * Résultat d'un scan de paire : une opportunité ou une erreur de quote.
 * @typedef {Opportunity | { pair: Pair, tradeSizeHuman: string, error: { code: string|number|null, shortMessage: string|null } }} ScanResult
 */

/**
 * Configuration complète du bot.
 * @typedef {Object} Config
 * @property {string} rpcUrl
 * @property {boolean} dryRun
 * @property {number} pollIntervalMs
 * @property {string} [privateKey]
 * @property {string} [contractAddress]
 * @property {bigint} aaveFlashLoanPremiumBps
 * @property {number} minProfitUsd
 * @property {number} minProfitBps
 * @property {bigint} minProfitBufferBps
 * @property {bigint} slippageBps
 * @property {bigint} gasLimitEstimate
 * @property {bigint} maxGasLimit
 * @property {number} gasPriceBufferPct
 * @property {number} expectedChainId
 * @property {number} maxWalletBalanceEth
 * @property {number} minWalletBalanceEth
 * @property {number} maxRpcErrorsPerScan
 * @property {number} maxDailyGasEth
 * @property {number} maxConsecutiveFailures
 * @property {number} circuitBreakerCooldownMinutes
 * @property {string} gasSpentPath
 * @property {string} circuitBreakerPath
 * @property {string} scanLogPath
 * @property {null | { kind: "V2", router: string, weth: string, usdc: string, usdcDecimals: number } | { kind: "V3", quoter: string, weth: string, usdc: string, usdcDecimals: number, fee: number }} ethUsdRoute
 * @property {Pair[]} pairs
 * @property {number|null} [ethUsdPrice]
 */

/**
 * État adaptatif du bot.
 * @typedef {Object} AdaptiveState
 * @property {number} effectiveMinProfitBps
 * @property {string} effectiveMaxTradeSize
 * @property {Array<{ outcome: "SUCCESS"|"FAILURE"|"UNKNOWN", at: number }>} history
 */

/**
 * Classification d'une erreur pour la politique de résilience.
 * @typedef {"TRANSIENT"|"PERMANENT"|"UNKNOWN"} ErrorClass
 */

/**
 * Statistiques de limitation de débit.
 * @typedef {Object} ThrottleStats
 * @property {number} calls
 * @property {number} totalWaitMs
 * @property {number|null} lastCallAt
 */

module.exports = {};
