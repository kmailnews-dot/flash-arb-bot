# Architecture du bot

Carte de lecture rapide du bot. Le contrat de types est `bot/domain.js` ; la configuration
d'environnement est `bot/config.js`. Les références sont volontairement des pointeurs
`fichier:ligne`, pas des extraits de code.

## Le flux

### Cycle ponctuel (scan.yml)

1. `.github/workflows/scan.yml` s'exécute en `DRY_RUN=true` sans secrets wallet et lance
   `npm run scan` (`package.json:13`) → `node bot/index.js`.
2. `main()` (`bot/index.js`) charge la config et crée le provider (réseau statique quand
   `EXPECTED_CHAIN_ID` est défini). Il lit d'abord le chainId réel via un seul `eth_chainId` brut
   et refuse le cycle s'il diffère de `EXPECTED_CHAIN_ID`, **avant** la réconciliation du journal
   et tout scan. Si `PAIR_SPREAD_MODE` vaut `shadow` ou `enforce`, il charge ensuite une seule
   fois `logs/pair_spreads.json` avec un `now` de cycle ; en `off`, aucun I/O d'état n'est effectué.
   Il lit ensuite en parallèle `feeData`, le prix ETH/USD et le numéro de bloc du
   cycle. Le premium Aave est relu on-chain.
3. Avant chaque paire, `decidePairSpread()` (`bot/pairSpread.js`) évalue l'historique avec
   `pair.minProfitBps` uniquement. En `shadow`, la décision est journalisée et la paire est
   scannée ; en `enforce`, une décision `skip` journalise `PAIR_SPREAD_BELOW_FLOOR`, incrémente
   `filteredPairs` et passe à la paire suivante sans `scanPair` ni entrée `scans.jsonl`. Sinon,
   `scanPair()` (`bot/scanner.js`) quote les tailles sur un `blockTag` unique
   fourni par le cycle. La quote d'entrée complète sert à la fois au contrôle de profondeur et à
   `scanTradeSize()` : 3 appels RPC pour une taille retenue (entrée pleine, entrée moitié, sortie)
   au lieu de 4. Les tailles sont scannées par ordre croissant ; dès qu'une taille dépasse la
   profondeur, toutes les tailles supérieures sont marquées `DEPTH_EXCEEDED` sans RPC. Chaque
   résultat est persisté dans `scans.jsonl` avant de choisir le meilleur. En `shadow`/`enforce`,
   le résultat du scan est classifié immédiatement : un `success` retient au plus un échantillon
   par clé et par cycle via `bestNetProfitBps(results)` et écrit un attempt `success` au même
   `at` ; sinon un attempt `empty` est écrit (`NO_RESULTS` si le tableau est vide, `UNPRICED` si
   au moins une quote tentée a un `amountIn` bigint > 0n mais aucun bps calculable,
   `QUOTE_ERRORS` sinon). Une exception de `scanPair` ou un retour non-tableau produit un
   attempt `failure` (`SCAN_ERROR`) puis suit le catch de paire historique. Une seule attempt
   finale est conservée par clé et par cycle, avec la précédence `success > failure > empty` ;
   à outcome égal, la première observation est conservée. Une paire filtrée, une erreur de
   `maybeExecute`, de logging ou de `scans.jsonl` ne produit aucun attempt `failure`. Les probes
   et le scheduler ne sont pas encore câblés : seuls les attempts de source `scan` sont produits.
4. Le scanner calcule un `netProfit` exact en unités du token emprunté (BigInt) : profit brut
   moins le gaz, lui-même converti avec le multiplicateur L1 (`l1CostMultiplierBps`). Une
   opportunité doit passer le plancher `effectiveMinProfitBps` sur le net, le plancher USD
   (`max(MIN_PROFIT_USD, 3×gaz)`) et rester strictement positive. Si le meilleur résultat est
   `isOpportunity`, `main()` appelle `maybeExecute()`. En `DRY_RUN`, `maybeExecute()` logge et
   s'arrête. Sinon il vérifie les secrets, estime le gaz, re-quote, appelle `decide()` puis
   `execute()`.
5. `execute()` (`bot/execute.js:236`) applique les guards, fait le `staticCall`, réserve le gaz,
   revérifie le breaker, envoie, attend le receipt et réconcilie le gaz (`bot/execute.js:236-798`).
   L'état d'exécution (gaz, breaker) est persisté par `guards.js`, pas par `persist.js`.

Le flux nominal « `scanPair()` → `decide()` → `execute()` → `persist()` » est donc réparti :
`decide()` est appelé dans `maybeExecute()`, `persist.js` journalise les scans avant l'exécution,
et l'état d'exécution est persisté par `guards.js` (`bot/guards.js:159-235`).

### Processus persistant

`run()` (`bot/run.js:75-185`) crée le provider (WebSocket si URL `ws(s)`, sinon JSON-RPC polling,
`bot/run.js:24-60`), démarre immédiatement un cycle (`bot/run.js:169-174`), puis replanifie un
`setTimeout` à la fin de chaque cycle (`bot/run.js:103-127`). Chaque cycle appelle
`main({ provider, config })` (`bot/run.js:115`). `SIGTERM`/`SIGINT` attendent le cycle en cours puis
ferment le provider (`bot/run.js:135-167`).

```
scan.yml (cron */5 min, DRY_RUN=true)
  └─ npm run scan → bot/index.js main()
       ├─ scanPair() → quoteLeg() × tailles → persist scans.jsonl
       └─ best.isOpportunity → maybeExecute()
            ├─ DRY_RUN → log puis stop
            └─ re-quote → decide() → execute()
                 └─ guards → staticCall → réservation → breaker → envoi → receipt

bot/run.js run() (process persistant)
  └─ setTimeout après chaque cycle → main({ provider, config })
```

## Les modules

| Fichier | Responsabilité | Export principal | Dépendances |
|---|---|---|---|
| `bot/domain.js` | Typedefs JSDoc du domaine (aucun runtime) | `{}` | aucune |
| `bot/pricing.js` | Arithmétique pure : slippage, gaz, fee overrides | `buildFeeOverrides`, `gasCostInBorrowedToken`, `withSlippage` | aucune |
| `bot/decide.js` | Décision pure `shouldExecute` + raisons de skip | `decide` | `minProfitUsd`, `pricing` |
| `bot/execute.js` | Guards, simulation, envoi, receipt, réconciliation gaz | `execute` | `ethers`, `guards`, `prices`, `pricing` |
| `bot/executor.js` | Façade : dry-run, estimation, re-quote, decide, execute | `maybeExecute` | `ethers`, `abis`, `prices`, `pricing`, `execute`, `decide` |
| `bot/guards.js` | Checks fail-closed + état persistant gaz/breaker | `checkCircuitBreaker`, `recordFailure`, `addGasSpent` | `fs/promises`, `path`, `ethers` |
| `bot/prices.js` | Quotes DEX V2 (`getAmountsOut`) et V3 (QuoterV2) | `quoteLeg` | `ethers`, `abis` |
| `bot/persist.js` | Journal JSONL des scans + formatage des logs | `appendScanResult`, `logEvent` | `fs/promises`, `path`, `sanitizeError` |
| `bot/scanner.js` | Scan des paires/tailles, profondeur, profit net exact (BigInt), prix ETH/USD | `scanPair`, `scanTradeSize`, `getEthUsdPrice` | `ethers`, `prices`, `pricing`, `sanitizeError`, `minProfitUsd` |
| `bot/index.js` | Un cycle complet (`main`) | `main` | `ethers`, `scanner`, `executor`, `persist`, `networks`, `guards`, `config` (lazy), `pairSpread`, `pairSpreadStore` |
| `bot/run.js` | Boucle persistante et gestion provider/signaux | `run` | `ethers`, `index` |
| `bot/adaptive.js` | Seuils adaptatifs bornés (MIN_PROFIT_BPS, taille de trade), historique | `loadAdaptive`, `recordOutcome`, `applyAdaptive` | `fs/promises`, `path` |
| `bot/pairSpread.js` | Décision pure de viabilité d'une paire : clé stable, fenêtre, médiane BigInt, échantillon | `decidePairSpread`, `buildPairKey`, `bestNetProfitBps` | aucune |
| `bot/pairSpreadStore.js` | État `logs/pair_spreads.json` v2 : samples + attempts, lecture v1, validation, écriture atomique | `loadPairSpreadState`, `recordPairSpreadCommit`, `recordPairSpreadSamples` | `fs/promises`, `path`, `crypto`, `pairSpread` |
| `bot/resilient.js` | Classification d'erreur + retry borné + backoff | `classifyError`, `shouldRetry`, `backoffMs` | aucune |
| `bot/throttle.js` | Sérialisation RPC + intervalle minimum + stats | `createThrottle`, `withThrottle`, `getStats` | aucune |
| `bot/netproxy.js` | Proxy SOCKS5 minimal (sans dépendance) + fabrique provider JSON-RPC ; réseau statique si `chainId` fourni, proxy si `RPC_PROXY_URL` défini | `createJsonRpcProvider` | `ethers`, `net`, `tls` |
| `bot/config.js` | Environnement → `Config` validée | `config` | `dotenv`, `ethers` |
| `bot/abis.js` | ABIs ERC-20, routeurs V2, QuoterV2, exécuteur | `FLASH_ARB_EXECUTOR_ABI` (et autres) | aucune |
| `bot/networks.js` | Adresses Aave par chaîne | `NETWORKS` | aucune |
| `bot/sanitizeError.js` | Rédaction des URLs et normalisation d'erreur | `sanitizeError`, `redactUrls` | aucune |
| `bot/minProfitUsd.js` | Conversions USD ↔ unités de token | `usdToTokenUnits`, `tokenUnitsToUsd` | aucune |

## Les invariants

- **Un SKIP ne modifie jamais le breaker.** Les sorties sans envoi (owner, breaker initial,
  chaîne, balance, `staticCall`, daily gas, réservation, breaker final) retournent directement,
  sans `recordFailure` : `bot/execute.js:307-310`, `333-336`, `341-344`, `353-356`, `377-382`,
  `391-394`, `401-403`, `426-431`. `recordFailure` n'apparaît qu'après une tentative d'envoi :
  `bot/execute.js:455-543`, `654-690`.
- **Un SEND ambigu incrémente le breaker.** Envoi dont l'issue est inconnue :
  `bot/execute.js:522-543`. Timeout ou receipt absent : `timeoutWaitReceiptError`
  (`bot/execute.js:165-173`), catch de confirmation (`bot/execute.js:654-688`) et `recordFailureSafely`
  avant la recherche tardive (`bot/execute.js:690-774`).
- **La réservation de gaz utilise `maxFeePerGas` si présent, sinon `gasPrice`.**
  `buildFeeOverrides` privilégie `maxFeePerGas` + `maxPriorityFeePerGas`
  (`bot/pricing.js:46-56`), sinon `gasPrice` (`bot/pricing.js:58-61`). `decide()` retient
  `maxFeePerGas ?? gasPrice` et calcule `gasCostWei` (`bot/decide.js:72-74`) ; `execute()` réserve
  ce montant avant l'envoi (`bot/execute.js:396-400`).
- **Le breaker est revérifié juste avant `startArbitrage`.** Check final
  `bot/execute.js:405-431`, puis envoi `bot/execute.js:444-454`.
- **`execute` ne décide pas, il exécute une `Decision` déjà prise.** Il reçoit `decision`
  (`bot/execute.js:236-244`) et consomme `decision.gasFloor`, `decision.gasCostWei`,
  `decision.gasPriceWei`, `decision.feeOverrides` (`bot/execute.js:358-366`, `387-399`,
  `433-436`) ; la décision est prise en amont (`bot/executor.js:215-220`).
- **`decide` ne fait aucun I/O.** Imports limités à `minProfitUsd` et `pricing`
  (`bot/decide.js:1-8`) ; fonction pure (`bot/decide.js:285-293`), aucun provider ni accès disque.
- **`pricing` ne fait aucun I/O.** Aucun import ; uniquement de l'arithmétique pure
  (`bot/pricing.js:1-162`).
- **Les guards fail-closed retournent `{ ok: false }` et bloquent l'envoi.** Contrat documenté
  `{ ok: true }` / `{ ok: false, error }` (`bot/guards.js`) ; `runGuard` convertit toute
  exception en `{ ok: false }` (`bot/execute.js:116-124`) et chaque échec retourne avant l'envoi
  (ex. `bot/execute.js:307-310`, `333-336`, `341-344`).
- **Le breaker propage les erreurs de lecture (M1-bis).** `checkCircuitBreaker` n'avale plus
  les erreurs du journal d'exécution (`listRecentTerminalExecutions`) ni des sous-contrôles
  gas-drawdown, RPC error rate et gas anomaly : un JSON corrompu (`STATE_FILE_CORRUPT`) ou un
  fichier illisible (`STATE_FILE_UNREADABLE`, avec code et chemin) remonte jusqu'à `runGuard`,
  qui retourne `{ ok: false }` et bloque l'envoi. Un fichier absent garde le fallback documenté
  (ENOENT → état neutre). Un schéma invalide de `rpc_errors.json` / `gas_history.json` reste
  fail-open (`STATE_FILE_SCHEMA_INVALID`, ADR 0004/0005) ; les autres erreurs, y compris
  internes, remontent. `circuit_breaker.json` et `gas_spent.json` sont validés et fail-closed,
  comme `executions.json` (`bot/persist.js`).
- **L'adaptive est borné.** `effectiveMinProfitBps` reste dans
  `[minProfitBps, min(minProfitBps * 2, 10000)]`, et `effectiveMaxTradeSize` dans
  `[0.10, 1.00]`. Un `logs/adaptive.json` corrompu ne peut pas sortir de ces bornes :
  `bot/adaptive.js:4-12`, `19-43`, `84-97`, `139-178`, `203-264`.
- **Le plafond de profondeur (0,5 %) est vérifié par quote d'impact dans `scanPair`
  (`bot/scanner.js`). Aucune quote au-delà du plafond n'est émise.**
- **Profils par paire (P1-10).** Chaque paire doit déclarer
  `profile: "majors" | "longtail"` et un `minProfitBps`
  obligatoire, borné : majors [10, 15], longtail [60, 100].
  `tradeSizes` est plafonné (0.1 majors, 1 longtail) en unités
  du borrowedToken (pas en USD). Validation dans
  `bot/config.js` `validatePairs`; `VALID_PROFILES` et
  `PROFILE_BOUNDS` sont des constantes de module.
- **Seuil de profit effectif (D7).** `decide`, `execute` et
  `executor` calculent
  `max(pair.minProfitBps, config.effectiveMinProfitBps)`.
  `pair.minProfitBps` est un plancher immuable ; l'adaptive ne
  peut pas le franchir à la baisse. Dette D7-bis : la formule
  est dupliquée à 3 endroits et devra être extraite dans un
  helper de `bot/pricing.js` (arithmétique pure).
- **Le blockTag de scan n'est pas propagé à execute (D4-ter).** `scanPair`
  fige un `blockTag` unique (via `provider.getBlockNumber()`) pour toutes
  les quotes du cycle, mais `execute()` re-quote au runtime avec le
  `blockTag` par défaut (`"latest"`). C'est volontaire : on veut l'état
  frais au moment de l'envoi, pas l'état figé au scan. Conséquence
  assumée : une opportunité peut disparaître entre `scanPair` et
  `execute()` ; c'est `decide()` dans `execute()` qui tranche.
- **`gasPaidWei` et `l1FeeWei` ne doivent jamais être additionnés
  (D5-bis).** `gasPaidWei` est le coût total (gas L2 × gasPrice +
  `receipt.l1Fee`), tandis que `l1FeeWei` n'est que la composante L1.
  Tout rapport P&L qui ferait `gasPaidWei + l1FeeWei` doublerait le
  coût L1. La réconciliation du budget gaz dans `guards.js` utilise
  déjà le total, ne pas réinjecter `l1FeeWei` séparément.
- **Le gestionnaire de nonce n'est actif qu'en mode réel
  (F-05-C).** `execute()` ne passe un `nonce` explicite à
  `startArbitrage` que si `config.dryRun === false` **et** que
  `provider.getTransactionCount` est une fonction. En
  `DRY_RUN=true`, comportement strictement inchangé. Le cache
  est module-level (`WeakMap<provider, Map<address, manager>>`),
  partagé entre appels pour un même provider, et relu au premier
  `next()` de chaque manager. Réf. : `bot/nonce.js`,
  `bot/execute.js` (`getNonceManager`, `nonceOverride`),
  `docs/adr/0001-nonce-manager.md`.
- **La resynchronisation sur `NONCE_EXPIRED` est faite (F-05-C-bis).**
  Le catch d'envoi (`bot/execute.js`) appelle `manager.reset()` sur
  `NONCE_EXPIRED` ou `REPLACEMENT_UNDERPRICED` avant tout autre
  traitement. Le catch `estimateGas` (`bot/executor.js`) appelle
  aussi `manager.reset()` sur `NONCE_EXPIRED` (fail-soft : un
  échec de reset ne masque pas l'erreur initiale, log
  `[NONCE WARNING]`). Test discriminant : `test/BotExecutor.test.js`
  (« resynchronizes the nonce manager when estimateGas fails with
  NONCE_EXPIRED »). Le cache reste périmé entre les deux si le
  reset lui-même échoue ; le prochain démarrage du process
  resynchronise.
- **Le retry est borné.** `shouldRetry` ne retente que les erreurs `TRANSIENT`, strictement sous
  `maxAttempts` (défaut 3), avec un backoff exponentiel plafonné à 4 s :
  `bot/resilient.js:1-3`, `119-139`.
- **Le throttle est par instance.** Deux `createThrottle` distincts n'interfèrent pas. Les appels
  sur le même throttle sont strictement sérialisés et espacés d'au moins `minIntervalMs`
  (défaut 250 ms) : `bot/throttle.js:1-2`, `4`, `20-42`, `44-78`.
- **`resilient` est intégré dans `waitForReceipt`.** Les erreurs `TRANSIENT`
  (ETIMEDOUT, ECONNRESET, RATE_LIMITED, ...) sont retentées avec un backoff borné (1 s puis 2 s)
  avant de propager la dernière erreur. `TIMEOUT_WAIT_RECEIPT` reste court-circuité. Réf. :
  `bot/execute.js:179-198`, `bot/resilient.js:1-3`, `:119-139`.
- **`throttle` est intégré par module.** Un throttle dédié par module (`scanner`, `execute`,
  `executor`, `main`), créé paresseusement à la première utilisation avec
  `THROTTLE_MIN_INTERVAL_MS` (défaut 250 ms). Deux throttles distincts restent indépendants. Réf. :
  `bot/scanner.js:17-27`, `bot/execute.js:57-67`, `bot/executor.js:19-29`, `bot/index.js:19-29`.
- **`adaptive` ajuste la config par cycle.** `loadAdaptive` lit `logs/adaptive.json`,
  `applyAdaptive` produit un `cycleConfig` distinct, `recordOutcome` n'est appelé qu'hors
  `DRY_RUN`. Réf. : `bot/index.js:123-151`, `:309-328`.
- **Le filtre pair-spread est fail-open et borné (P1-16-bis).** En mode `off`, aucun I/O sur
  `logs/pair_spreads.json`. En `shadow`/`enforce`, l'état est chargé une seule fois après la
  vérification du chainId, avec un `now` unique ; une erreur de chargement laisse le cycle
  continuer avec un historique vide. `decidePairSpread()` ne compare que `pair.minProfitBps`
  (jamais `effectiveMinProfitBps`) et ne saute une paire qu'en `enforce`. Après un scan réussi,
  `bestNetProfitBps()` retient au plus un échantillon par clé et par cycle. Le même cycle
  enregistre au plus une attempt finale par clé, avec la précédence `success > failure > empty` :
  `success` si `bestNetProfitBps()` retourne une valeur (même nulle ou négative), `empty` sinon
  (`NO_RESULTS`, `UNPRICED` si au moins une quote tentée avec `amountIn` bigint > 0n n'a pas de
  bps, `QUOTE_ERRORS` sinon), `failure` (`SCAN_ERROR`) si `scanPair` lève ou retourne autre chose
  qu'un tableau. À outcome égal, la première observation de la clé est conservée. Une erreur de
  `maybeExecute`, du logging ou de `scans.jsonl` ne produit pas de `failure`.
  L'état est écrit au plus une fois après la boucle via `recordPairSpreadCommit`, jamais s'il est
  corrompu, illisible ou d'une version inconnue. Le schéma courant est v2 : chaque paire porte
  `samples` et `attempts` (obligatoire, même vide) ; v1 reste lisible et migré en mémoire. Les
  attempts sont dédupliqués sur `(at, outcome, source, reason)` avant le plafond de 20. Un
  attempt futur rend l'état non inscriptible (fail-open) jusqu'à ce que l'horloge le dépasse,
  sans purge silencieuse. Une lecture ne réécrit pas le fichier uniquement pour le normaliser ;
  la forme canonique v2 est persistée à la prochaine écriture réelle. Réf. : `bot/pairSpread.js`,
  `bot/pairSpreadStore.js`, `bot/index.js` (`resolvePairSpreadSettings`, `pairSpreadNow`, boucle
  des paires, persistance finale), ADR 0006 D1, D2-bis, D6, D8, D14.
- **Exit code D13 : un cycle entièrement filtré est un succès volontaire.** Si `enforce` filtre
  toutes les paires configurées sans erreur indépendante, `exitCode` vaut `0` ; sinon le
  comportement `scanned === 0 → 1` est conservé (aucune paire, zéro scan non volontaire, refus
  chainId, erreur de paire ou seuil RPC). Une paire filtrée n'écrit pas dans `scans.jsonl` et
  n'incrémente pas `scanned`. Réf. : `bot/index.js` (`allPairsFiltered`, `filteredPairs`),
  ADR 0006 D13.
- **Les chemins d'état sont absolus et ancrés sur le module.** `gasSpentPath`,
  `circuitBreakerPath`, `DEFAULT_SCAN_LOG_PATH` et `DEFAULT_ADAPTIVE_PATH` dérivent de
  `path.resolve(__dirname, "..", "logs")` (`bot/guards.js:9-13`, `bot/persist.js:5-6`,
  `bot/adaptive.js:13-14`). `writeState` écrit un temporaire, appelle `fh.sync()` puis `rename`
  (`bot/guards.js:78-89`). `readState` renvoie le fallback sur `ENOENT`, convertit une
  `SyntaxError` en `STATE_FILE_CORRUPT` et enveloppe les autres erreurs d'E/S en
  `STATE_FILE_UNREADABLE` avec le chemin du fichier (`bot/guards.js:66-76`).
- **Un rejet certain avant broadcast est non ambigu.** Dans le catch de `startArbitrage`
  (`bot/execute.js:455-543`), `REJECTED_BEFORE_ACCEPTANCE` (`INSUFFICIENT_FUNDS`, `NONCE_EXPIRED`,
  `REPLACEMENT_UNDERPRICED`, `INVALID_ARGUMENT` ; `bot/execute.js:47-52`) libère la réservation
  (`bot/execute.js:512-520`) et n'incrémente pas le breaker. Toute autre erreur reste ambiguë :
  réservation conservée, `recordFailureSafely` appelé, `submitted: true` (`bot/execute.js:522-543`).
  La libération s'applique aussi au breaker final après réservation (`bot/execute.js:426-431`).
  La branche `if (err.receipt)` est défensive : mocks uniquement, pas de receipt sur
  `sendTransaction` en ethers v6 (`bot/execute.js:467-510`).

## Les typedefs

Contrat de types : `bot/domain.js` (aucun export runtime, `bot/domain.js:215`).

- `Token` — `bot/domain.js:3`
- `Leg` — `bot/domain.js:13`
- `Pair` — `bot/domain.js:23`
- `Opportunity` — `bot/domain.js:35`
- `FeeData` — `bot/domain.js:63`
- `ReQuote` — `bot/domain.js:71`
- `Pricing` — `bot/domain.js:81`
- `Decision` — `bot/domain.js:89`
- `ExecutionResult` — `bot/domain.js:131`
- `ScanResult` — `bot/domain.js:160`
- `Config` — `bot/domain.js:165`
- `AdaptiveState` — `bot/domain.js:196`
- `ErrorClass` — `bot/domain.js:204`
- `ThrottleStats` — `bot/domain.js:209`

## Les points d'entrée

- `bot/index.js` : un cycle (`main`, `bot/index.js:116`), CLI avec code de sortie
  (`bot/index.js:374-380`).
- `bot/run.js` : process persistant (`run`, `bot/run.js:75`), CLI et arrêt propre
  (`bot/run.js:189-207`).
- `bot/adaptive.js` : `loadAdaptive`, `recordOutcome`, `applyAdaptive`.
- `bot/pairSpread.js` : `decidePairSpread`, `buildPairKey`, `bestNetProfitBps`.
- `bot/pairSpreadStore.js` : `loadPairSpreadState`, `recordPairSpreadCommit`,
  `recordPairSpreadSamples` (API samples-only compatible).
- `bot/resilient.js` : `classifyError`, `shouldRetry`, `backoffMs`.
- `bot/throttle.js` : `createThrottle`, `withThrottle`, `getStats`.
- `bot/scanner.js` : `getScannerThrottle`.
- `bot/execute.js` : `getExecuteThrottle`.
- `bot/executor.js` : `getExecutorThrottle`.
- `bot/index.js` : `getMainThrottle`.
- `bot/executor.js` : façade `maybeExecute` (`bot/executor.js:34`) ; verrou mono-transaction
  `txInFlight` (`bot/executor.js:17`, `41-59`, `242-245`).
- npm scripts : `scan` → `node bot/index.js`, `start:run` → `node bot/run.js`
  (`package.json:13-14`).

## Les pièges

- **Ordre des guards dans `execute`.** Re-quote d'abord (`bot/execute.js:267-299`), puis owner
  (`301-310`), breaker initial (`312-336`), `chainId` (`338-344`), balance (`346-356`),
  `staticCall` (`369-382`), daily gas (`384-394`), réservation (`396-403`), breaker revérifié
  (`405-431`), envoi (`444-454`). Cet ordre a changé à l'étape 3 : ne pas se fier à l'ancien ordre
  documenté ailleurs.
- **`opportunity.grossProfitFresh` est un champ non standard.** Il est lu par `decide()`
  (`bot/decide.js:53`) mais absent du typedef `Opportunity` (`bot/domain.js:35-59`). Il est injecté
  par `maybeExecute()` juste avant `decide()` (`bot/executor.js:215-220`), et `execute()` le recalcule
  quand aucun `reQuoted` n'est fourni (`bot/execute.js:267-289`). Il préserve la sémantique
  caché/frais entre `decide` et `execute` (notamment pour `minProfit`, `bot/execute.js:358-366`).
- **Fallback sur échec de re-quote dans `maybeExecute`.** Si le re-quote échoue, une `decide()` sur
  les données cachées est retentée ; si elle refuse, sa raison remplace « re-quote failed »
  (`bot/executor.js:192-213`). C'est volontaire pour préserver les raisons et tests existants. Dans
  `execute()`, un échec de re-quote retourne bien « re-quote failed » (`bot/execute.js:290-298`).
- **`executor.js` réexporte des symboles de `pricing`.** `buildFeeOverrides`,
  `gasCostInBorrowedToken`, `BPS_DENOMINATOR`, `GAS_COST_MARGIN_BPS`, `GAS_LIMIT_MARGIN_BPS`
  (`bot/executor.js:4-11`, `248-255`) pour compatibilité des tests. À terme, les tests pourront
  importer directement depuis `pricing.js`.
- **Divergence breaker / adaptive.** Un timeout ambigu avec receipt tardif `status=1` est classé
  `SUCCESS` par `index.js` (l'issue adaptative reflète le résultat on-chain), alors que
  `execute.js` a déjà compté un échec breaker (`bot/execute.js:654-690`). C'est voulu : l'adaptive
  et le breaker mesurent des choses différentes (`bot/index.js:313-328`).
- **`resilient.js` ne traverse pas `error.error` / `error.cause` / `error.info.error`.** Un
  `NOT_PROFITABLE` uniquement présent dans ces champs imbriqués serait classé `UNKNOWN`.
  `isNotProfitableError` dans `execute.js` traverse ces chaînes pour la logique de skip
  (`bot/execute.js:200-213`). À noter si un test d'intégration révèle un mauvais classement
  (`bot/resilient.js:67-80`).
- **`throttle.js` ne borne pas la chaîne de promesses.** Si `fn` reste bloqué, les appels suivants
  s'accumulent en mémoire sans limite ni timeout ni annulation. À noter pour une future limite
  `maxQueueSize` ou timeout par appel (`bot/throttle.js:44-78`).
- **Écart de timing sur `waitForReceipt`.** Le message de commit `f66804f` mentionne
  « 500 ms, 1 s, 2 s », mais `attempt` est incrémenté avant le sleep, donc l'implémentation réelle
  applique 1 s puis 2 s (soit 3 s de backoff cumulé). Le comportement reste borné et sûr ; c'est la
  doc qui doit être lue avec cette correction. Réf. : `bot/execute.js:179-198`.
- **Création paresseuse du throttle.** Le premier appel fixe `throttleMinIntervalMs` pour tout le
  process. Si la config change à chaud, le nouvel intervalle est ignoré. Réf. :
  `bot/scanner.js:17-27`, `bot/execute.js:57-67`, `bot/executor.js:19-29`, `bot/index.js:19-29`.
- **Sur-sérialisation de `main`.** `getNetwork` et `getFeeData` partagent `mainThrottle` et sont
  donc espacés de 250 ms au lieu d'être réellement parallèles. Acceptable (2 appels par cycle), à
  noter si le cycle devient sensible à la latence. Réf. : `bot/index.js:188-196`.
- **Frontière d'exception du scan.** Seul un throw de `scanPairImpl` ou un retour non-tableau
  (vérifié par `Array.isArray(results)` dans la même frontière) produit un attempt `failure`
  (`SCAN_ERROR`). Le try/catch interne est volontairement limité à cet appel ; une erreur de
  `maybeExecute`, du logging ou de l'écriture de `scans.jsonl` survient après l'observation et ne
  doit jamais être classée comme failure de scan. Le throw est ensuite relayé au catch de paire
  historique pour préserver `pairErrors`, les warnings et l'`exitCode`. Réf. : `bot/index.js`
  (boucle des paires), ADR 0006 D2-bis.
- **Une attempt finale par clé et par cycle.** La fusion est indexée par clé stable, pas par
  timestamp, avec la précédence `success > failure > empty`. Un doublon de route qui échoue après
  un scan valide ne doit pas remplacer le `success` ni le sample déjà collecté. À outcome égal, la
  première observation est conservée. Ne pas dédupliquer uniquement sur `at` : deux paires
  distinctes peuvent partager le même `now`. Réf. : `bot/index.js` (`mergePairSpreadAttempt`),
  ADR 0006 D2-bis/D8.
- **Pair filtrée : warning, pas de quote fantôme.** En `enforce`, le log `SKIP` est émis en
  `warn` (console) et la paire n'écrit ni `scans.jsonl`, ni échantillon, ni attempt. Ne pas compter
  ce warning comme une erreur RPC ou de paire : il ne doit pas modifier `rpcErrors`, `pairErrors`
  ni l'`exitCode` au-delà de la règle D13. Réf. : `bot/index.js` (`logPairSpreadEvent`,
  `pair_spread_filtered`).
- **Le filtre ne remplace ni P1-16 ni `decide()`.** P1-16 reste fail-closed au chargement,
  `decide()` reste fail-closed avant exécution ; P1-16-bis est la seule couche fail-open et ne
  protège pas le capital (ADR 0006 D11–D12). Ne pas déplacer la comparaison de spread dans
  `decide()` ni dans les guards.
- **Attempt futur = état non inscriptible, pas de purge.** Un attempt stocké avec `at > now`
  rend `loadPairSpreadState` non inscriptible (`schema_invalid`, fail-open) ; aucune écriture
  n'écrase le fichier. Le comportement est temporaire : il se résout quand l'horloge dépasse
  `at`. Ne pas « corriger » en purgeant l'attempt ou en le remplaçant par `now` : ce serait
  fabriquer une observation. Réf. : `bot/pairSpreadStore.js` (`parseStoredAttempt`), ADR 0006 D6.
- **Conflit sample/attempt non-success : uniquement sur un sample survivant.** Un sample expiré,
  tronqué par la fenêtre ou éliminé comme doublon de moindre valeur ne doit pas faire échouer un
  commit. Seuls un nouveau timestamp retenu ou une meilleure valeur à un timestamp existant
  déclenchent le conflit. Ne pas élargir la règle à toutes les entrées brutes.
  Réf. : `bot/pairSpreadStore.js` (`appendPairSpreadCommit`), ADR 0006 D6/D8.
- **Normalisation sans réécriture.** Un chargement trie, déduplique et plafonne en mémoire, mais
  un commit no-op ne réécrit pas le fichier uniquement pour le normaliser ; la forme canonique v2
  est persistée à la prochaine écriture réelle. Ne pas ajouter de réécriture « de confort » :
  elle n'apporte pas d'intégrité (chaque lecture normalise) et romprait la politique D14.
  Réf. : `bot/pairSpreadStore.js` (`recordPairSpreadCommit`), ADR 0006 D14.
- **Test `throttle` non flaky.** L'ancien test `respects minIntervalMs and measures the actual
  wait` mesurait une durée réelle et pouvait échouer si l'event loop était bloqué. Il a été
  remplacé par `accumulates wait time in stats when the min interval has not elapsed`, qui vérifie
  `stats.totalWaitMs > 0` sans dépendre d'une durée précise. Réf. : `test/BotThrottle.test.js:127-135`.

## Ce que le bot ne fait PAS

- **Pas de Timeboost.** L'envoi est un appel `contract.startArbitrage` via le provider ethers
  standard (`bot/execute.js:444-454`) ; aucun chemin Express Lane ni transaction privée. Rappel
  MEV point 2 : environ 200 ms de délai pour les transactions non-Express-Lane.
- **Pas de RPC privé par défaut.** Une seule URL `ARBITRUM_RPC_URL` (`bot/config.js`) ; `run.js`
  choisit WebSocket ou HTTP. Un RPC public ajoute typiquement 100–500 ms par appel.
- **Réseau statique + vérification brute.** Quand `EXPECTED_CHAIN_ID` est défini,
  `createJsonRpcProvider({ chainId })` construit un provider à réseau statique : ethers ne refait
  plus un `eth_chainId` avant chaque `eth_call`. Le benchmark final ne compte plus qu'un seul
  `eth_chainId` par cycle. La sécurité est conservée par un `eth_chainId` brut unique dans `main()` et par
  `checkChainId()` (`bot/guards.js`), qui interroge aussi le RPC directement quand `provider.send`
  existe. Un provider injecté sans `send` retombe sur `getNetwork()`.
- **Pas de proxy réseau par défaut.** `RPC_PROXY_URL` non défini → aucun agent SOCKS5 n'est créé
  (`bot/netproxy.js` no-op strict) ; le pinning de réseau reste indépendant. Sémantique
  socks5h (résolution du hostname par le proxy). Mesuré (`scripts/measure-rpc-latency.js`, N=25,
  2026-11-16, 0 erreur) : direct p50/p95 = 208/233 ms ; Tor connexion neuve = 559/995 ms (rejeté) ;
  Tor tunnel keep-alive = 217/598 ms. Fail-closed : `ws://` rejeté au chargement de config quand le
  proxy est défini (`bot/config.js`, `validateProxyConfig`).
- **Pas de live sans `DRY_RUN=false` + `PRIVATE_KEY` + `CONTRACT_ADDRESS`.** `dryRun` vaut `true`
  par défaut (`bot/config.js:324`), et `maybeExecute()` refuse d'envoyer sans les deux secrets
  (`bot/executor.js:90-93`). Le live exige aussi un prix ETH/USD (`bot/index.js:212-217`).
- **Pas d'apprentissage de code.** L'adaptive ajuste deux paramètres dans des bornes fixes
  (`logs/adaptive.json`), sans jamais modifier la logique. `resilient` et `throttle` bornent
  respectivement le retry et la pression RPC. Aucun de ces modules ne réécrit de code source.
- **Pas de garantie de profit.** Les filtres de `decide()` (`bot/decide.js:95-265`), le `staticCall`
  (`bot/execute.js:369-382`) et les guards réduisent le risque mais ne garantissent rien. Rappel
  MEV point 7 : la configuration actuelle est jugée économiquement défavorable.

## Dettes documentées

Les quatre dettes ci-dessous sont documentées mais non
corrigées. Elles correspondent à des choix de conception
assumés, pas à des bugs.

- **D3-breaker-ter — fenêtre partielle du breaker.** La garde
  `revertWindowFull`/`unknownWindowFull` exige que la fenêtre
  soit pleine (20 records) avant d'évaluer un taux de revert ou
  d'unknown. Avant la fenêtre pleine, le breaker est fail-open.
  C'est volontaire : sur les 19 premiers trades, un taux calculé
  sur 3 records n'a pas de sens statistique.
- **D3-breaker-quater — réévaluation du taux après cooldown.**
  Le taux de revert/unknown n'est pas réévalué à l'expiration du
  cooldown. Le breaker se ferme, puis la prochaine tentative
  incrémente le compteur et évalue le taux sur l'historique
  courant. C'est volontaire : évite de rouvrir immédiatement
  sur un historique non purgé.
- **D4-ter — propagation du blockTag de scan à execute.** `scanPair`
  fige un `blockTag` unique pour toutes les quotes du cycle, mais
  `execute()` re-quote en `"latest"`. C'est volontaire : on veut
  l'état frais au moment de l'envoi, pas l'état figé au scan. Une
  opportunité peut disparaître entre `scanPair` et `execute()`, et
  c'est `decide()` dans `execute()` qui tranche.
- **D5-bis — gasPaidWei vs l1FeeWei.** `gasPaidWei` est le coût
  total (gas L2 × gasPrice + `receipt.l1Fee`), tandis que
  `l1FeeWei` n'est que la composante L1. Tout rapport P&L qui
  ferait `gasPaidWei + l1FeeWei` doublerait le coût L1. La
  réconciliation du budget gaz dans `guards.js` utilise déjà le
  total, ne pas réinjecter `l1FeeWei` séparément.
- **P1-12 — balayage logarithmique et interpolation locale
  (ADR 0003).** `scanPair` accepte soit `pair.tradeSizes`
  (legacy), soit `pair.logSweep = { min, max, steps }`
  (nouveau). Les deux sont mutuellement exclusifs. Avec
  `logSweep`, `scanPair` génère une grille logarithmique via
  `logSweepSizes` (`bot/pricing.js`), quote chaque taille,
  trie par profit décroissant, puis appelle
  `interpolateMaximum` sur les points triés par taille. Si un
  maximum local est trouvé, la taille interpolée est
  **re-quotée** sur le même `blockTag` ; elle n'est retenue
  que si son profit net (BigInt) dépasse celui du meilleur
  point de grille. Le résultat retenu est marqué
  `interpolated: true` et ses montants correspondent à la
  quote réelle. Une erreur de re-quote conserve le meilleur
  point de grille. `decide()` dans `execute()` re-quote
  ensuite à `"latest"` avant tout envoi. Réf. :
  `docs/adr/0003-log-sweep-regression.md`,
  `bot/pricing.js` (`logSweepSizes`, `interpolateMaximum`),
  `bot/scanner.js` (`scanPair`), `bot/config.js`
  (`validatePairs`).
- **D3-breaker-bis-c — RPC error rate breaker (ADR 0004).**
  `recordRpcCycle` (`bot/guards.js`) persiste un cycle
  `{ errors, total, at }` dans `logs/rpc_errors.json` après
  chaque scan (`bot/index.js`). `checkRpcErrorRate`
  (`bot/guards.js`) calcule `sum(errors)/sum(total)` sur les
  `rpcErrorRateWindowSize` cycles les plus récents (défaut 10)
  et ouvre le breaker si le taux dépasse
  `rpcErrorRateThreshold` (défaut 0.5). `checkCircuitBreaker`
  appelle `checkRpcErrorRate` comme 5e condition, après le
  gas-drawdown. Fail-open sur fichier absent ou schéma
  invalide ; fail-closed sur JSON corrompu (via
  `STATE_FILE_CORRUPT`) et sur erreur d'E/S (`STATE_FILE_UNREADABLE`,
  M1-bis). Config : `RPC_ERROR_RATE_WINDOW_SIZE`,
  `RPC_ERROR_RATE_THRESHOLD`, `RPC_ERRORS_PATH`. Réf. :
  `docs/adr/0004-rpc-error-rate-breaker.md`,
  `bot/guards.js` (`recordRpcCycle`, `checkRpcErrorRate`),
  `bot/index.js` (`main`), `bot/config.js`.
- **D3-breaker-bis-b — gas anomaly breaker (ADR 0005).**
  `recordGasSample` (`bot/guards.js`) persiste un échantillon
  `{ gasPriceWei, at }` dans `logs/gas_history.json` après
  chaque scan (`bot/index.js`). `checkGasAnomaly`
  (`bot/guards.js`) calcule la médiane des `gasPriceWei` sur
  les `gasAnomalyWindowSize` échantillons les plus récents
  (défaut 20), et ouvre le breaker si le dernier échantillon
  dépasse `gasAnomalyMultiplier × médiane` (défaut 3).
  `checkCircuitBreaker` appelle `checkGasAnomaly` comme 6e
  condition, après le RPC error rate. Fail-open sur fichier
  absent, échantillons insuffisants (< `gasAnomalyMinSamples`,
  défaut 5) ou schéma invalide ; fail-closed sur JSON corrompu
  et sur erreur d'E/S (`STATE_FILE_UNREADABLE`, M1-bis).
  Config : `GAS_ANOMALY_WINDOW_SIZE`, `GAS_ANOMALY_MULTIPLIER`,
  `GAS_ANOMALY_MIN_SAMPLES`, `GAS_HISTORY_PATH`. Réf. :
  `docs/adr/0005-gas-anomaly-breaker.md`,
  `bot/guards.js` (`recordGasSample`, `checkGasAnomaly`),
  `bot/index.js` (`main`), `bot/config.js`.
