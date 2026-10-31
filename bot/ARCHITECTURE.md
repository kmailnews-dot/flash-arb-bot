# Architecture du bot

Carte de lecture rapide du bot. Le contrat de types est `bot/domain.js` ; la configuration
d'environnement est `bot/config.js`. Les références sont volontairement des pointeurs
`fichier:ligne`, pas des extraits de code.

## Le flux

### Cycle ponctuel (scan.yml)

1. `.github/workflows/scan.yml` s'exécute en `DRY_RUN=true` sans secrets wallet et lance
   `npm run scan` (`package.json:13`) → `node bot/index.js`.
2. `main()` (`bot/index.js:84`) charge la config (`bot/index.js:90`), crée le provider, lit en
   parallèle réseau, `feeData` et prix ETH/USD (`bot/index.js:99-104`), puis refuse le live si le
   prix ETH/USD est indisponible (`bot/index.js:121-126`). Le premium Aave est relu on-chain
   (`bot/index.js:128`).
3. Pour chaque paire, `scanPair()` (`bot/scanner.js:123-137`) quote toutes les tailles via
   `scanTradeSize()` (`bot/scanner.js:71-119`). Chaque résultat est persisté immédiatement dans
   `scans.jsonl` (`bot/index.js:154-156`) avant de choisir le meilleur (`bot/index.js:192-204`).
4. Si le meilleur résultat est `isOpportunity` (`bot/scanner.js:117`), `main()` appelle
   `maybeExecute()` (`bot/index.js:206-209`). En `DRY_RUN`, `maybeExecute()` logge et s'arrête
   (`bot/executor.js:51-59`). Sinon il vérifie les secrets (`bot/executor.js:61-64`), estime le gaz
   (`bot/executor.js:80-102`), re-quote (`bot/executor.js:111-129`), appelle `decide()`
   (`bot/executor.js:153-158`) puis `execute()` (`bot/executor.js:171-179`).
5. `execute()` (`bot/execute.js:129`) applique les guards, fait le `staticCall`, réserve le gaz,
   revérifie le breaker, envoie, attend le receipt et réconcilie le gaz (`bot/execute.js:182-336`).
   L'état d'exécution (gaz, breaker) est persisté par `guards.js`, pas par `persist.js`.

Le flux nominal « `scanPair()` → `decide()` → `execute()` → `persist()` » est donc réparti :
`decide()` est appelé dans `maybeExecute()`, `persist.js` journalise les scans avant l'exécution,
et l'état d'exécution est persisté par `guards.js` (`bot/guards.js:123-181`).

### Processus persistant

`run()` (`bot/run.js:57-157`) crée le provider (WebSocket si URL `ws(s)`, sinon JSON-RPC polling,
`bot/run.js:22-42`), démarre immédiatement un cycle (`bot/run.js:146`), puis replanifie un
`setTimeout` à la fin de chaque cycle (`bot/run.js:88-104`). Chaque cycle appelle
`main({ provider, config })` (`bot/run.js:92`). `SIGTERM`/`SIGINT` attendent le cycle en cours puis
ferment le provider (`bot/run.js:112-144`).

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
| `bot/scanner.js` | Scan des paires/tailles, prix ETH/USD, coût gaz USD | `scanPair`, `scanTradeSize`, `getEthUsdPrice` | `ethers`, `prices` |
| `bot/index.js` | Un cycle complet (`main`) | `main` | `ethers`, `scanner`, `executor`, `persist`, `networks`, `guards`, `config` (lazy) |
| `bot/run.js` | Boucle persistante et gestion provider/signaux | `run` | `ethers`, `index` |
| `bot/adaptive.js` | Seuils adaptatifs bornés (MIN_PROFIT_BPS, taille de trade), historique | `loadAdaptive`, `recordOutcome`, `applyAdaptive` | `fs/promises`, `path` |
| `bot/resilient.js` | Classification d'erreur + retry borné + backoff | `classifyError`, `shouldRetry`, `backoffMs` | aucune |
| `bot/throttle.js` | Sérialisation RPC + intervalle minimum + stats | `createThrottle`, `withThrottle`, `getStats` | aucune |
| `bot/config.js` | Environnement → `Config` validée | `config` | `dotenv`, `ethers` |
| `bot/abis.js` | ABIs ERC-20, routeurs V2, QuoterV2, exécuteur | `FLASH_ARB_EXECUTOR_ABI` (et autres) | aucune |
| `bot/networks.js` | Adresses Aave par chaîne | `NETWORKS` | aucune |
| `bot/sanitizeError.js` | Rédaction des URLs et normalisation d'erreur | `sanitizeError`, `redactUrls` | aucune |
| `bot/minProfitUsd.js` | Conversions USD ↔ unités de token | `usdToTokenUnits`, `tokenUnitsToUsd` | aucune |

## Les invariants

- **Un SKIP ne modifie jamais le breaker.** Les sorties sans envoi (owner, breaker initial,
  chaîne, balance, `staticCall`, daily gas, réservation, breaker final) retournent directement,
  sans `recordFailure` : `bot/execute.js:188-191`, `196-199`, `204-207`, `216-219`, `231-238`,
  `247-250`, `257-259`, `264-267`. `recordFailure` n'apparaît qu'après une tentative d'envoi :
  `bot/execute.js:280-292`, `303-335`.
- **Un SEND ambigu incrémente le breaker.** Envoi dont l'issue est inconnue :
  `bot/execute.js:290-292`. Timeout ou receipt absent : `timeoutWaitReceiptError`
  (`bot/execute.js:93-112`), catch de confirmation (`bot/execute.js:313-335`) et `recordFailureSafely`
  avant la recherche tardive (`bot/execute.js:323-332`).
- **La réservation de gaz utilise `maxFeePerGas` si présent, sinon `gasPrice`.**
  `buildFeeOverrides` privilégie `maxFeePerGas` + `maxPriorityFeePerGas`
  (`bot/pricing.js:36-46`), sinon `gasPrice` (`bot/pricing.js:48-51`). `decide()` retient
  `maxFeePerGas ?? gasPrice` et calcule `gasCostWei` (`bot/decide.js:70-72`) ; `execute()` réserve
  ce montant avant l'envoi (`bot/execute.js:252-256`).
- **Le breaker est revérifié juste avant `startArbitrage`.** Check final
  `bot/execute.js:261-267`, puis envoi `bot/execute.js:274-279`.
- **`execute` ne décide pas, il exécute une `Decision` déjà prise.** Il reçoit `decision`
  (`bot/execute.js:129-137`) et consomme `decision.gasFloor`, `decision.gasCostWei`,
  `decision.gasPriceWei`, `decision.feeOverrides` (`bot/execute.js:221-227`, `269-272`) ; la
  décision est prise en amont (`bot/executor.js:153-179`).
- **`decide` ne fait aucun I/O.** Imports limités à `minProfitUsd` et `pricing`
  (`bot/decide.js:1-8`) ; fonction pure (`bot/decide.js:273-281`), aucun provider ni accès disque.
- **`pricing` ne fait aucun I/O.** Aucun import ; uniquement de l'arithmétique `bigint`
  (`bot/pricing.js:1-64`).
- **Les guards fail-closed retournent `{ ok: false }` et bloquent l'envoi.** Contrat documenté
  `{ ok: true }` / `{ ok: false, error }` (`bot/guards.js:28-29`) ; `runGuard` convertit toute
  exception en `{ ok: false }` (`bot/execute.js:44-51`) et chaque échec retourne avant l'envoi
  (ex. `bot/execute.js:188-191`, `204-207`, `216-219`).
- **L'adaptive est borné.** `effectiveMinProfitBps` reste dans
  `[minProfitBps, min(minProfitBps * 2, 10000)]`, et `effectiveMaxTradeSize` dans
  `[0.10, 1.00]`. Un `logs/adaptive.json` corrompu ne peut pas sortir de ces bornes :
  `bot/adaptive.js:4-11`, `20-40`, `84-98`, `154-182`.
- **Le retry est borné.** `shouldRetry` ne retente que les erreurs `TRANSIENT`, strictement sous
  `maxAttempts` (défaut 3), avec un backoff exponentiel plafonné à 4 s :
  `bot/resilient.js:1-3`, `19-30`, `84-104`.
- **Le throttle est par instance.** Deux `createThrottle` distincts n'interfèrent pas. Les appels
  sur le même throttle sont strictement sérialisés et espacés d'au moins `minIntervalMs`
  (défaut 250 ms) : `bot/throttle.js:1-2`, `4`, `20-42`, `44-78`.

## Les typedefs

Contrat de types : `bot/domain.js` (aucun export runtime, `bot/domain.js:172`).

- `Token` — `bot/domain.js:1`
- `Leg` — `bot/domain.js:11`
- `Pair` — `bot/domain.js:21`
- `Opportunity` — `bot/domain.js:32`
- `FeeData` — `bot/domain.js:53`
- `ReQuote` — `bot/domain.js:61`
- `Pricing` — `bot/domain.js:71`
- `Decision` — `bot/domain.js:79`
- `ExecutionResult` — `bot/domain.js:102`
- `ScanResult` — `bot/domain.js:115`
- `Config` — `bot/domain.js:120`
- `AdaptiveState` — `bot/domain.js:151`
- `ErrorClass` — `bot/domain.js:159`
- `ThrottleStats` — `bot/domain.js:164`

## Les points d'entrée

- `bot/index.js` : un cycle (`main`, `bot/index.js:84`), CLI avec code de sortie
  (`bot/index.js:230-237`).
- `bot/run.js` : process persistant (`run`, `bot/run.js:57`), CLI et arrêt propre
  (`bot/run.js:161-178`).
- `bot/adaptive.js` : `loadAdaptive`, `recordOutcome`, `applyAdaptive`.
- `bot/resilient.js` : `classifyError`, `shouldRetry`, `backoffMs`.
- `bot/throttle.js` : `createThrottle`, `withThrottle`, `getStats`.
- `bot/executor.js` : façade `maybeExecute` (`bot/executor.js:19`) ; verrou mono-transaction
  `txInFlight` (`bot/executor.js:14`, `26-30`, `180-182`).
- npm scripts : `scan` → `node bot/index.js`, `start:run` → `node bot/run.js`
  (`package.json:13-14`).

## Les pièges

- **Ordre des guards dans `execute`.** Re-quote d'abord (`bot/execute.js:142-180`), puis owner
  (`182-191`), breaker initial (`193-199`), `chainId` (`201-207`), balance (`209-219`),
  `staticCall` (`231-238`), daily gas (`240-250`), réservation (`252-259`), breaker revérifié
  (`261-267`), envoi (`274-279`). Cet ordre a changé à l'étape 3 : ne pas se fier à l'ancien ordre
  documenté ailleurs.
- **`opportunity.grossProfitFresh` est un champ non standard.** Il est lu par `decide()`
  (`bot/decide.js:53`) mais absent du typedef `Opportunity` (`bot/domain.js:32-51`). Il est injecté
  par `maybeExecute()` juste avant `decide()` (`bot/executor.js:154`), et `execute()` le recalcule
  quand aucun `reQuoted` n'est fourni (`bot/execute.js:142-170`). Il préserve la sémantique
  caché/frais entre `decide` et `execute` (notamment pour `minProfit`, `bot/execute.js:221-227`).
- **Fallback sur échec de re-quote dans `maybeExecute`.** Si le re-quote échoue, une `decide()` sur
  les données cachées est retentée ; si elle refuse, sa raison remplace « re-quote failed »
  (`bot/executor.js:130-151`). C'est volontaire pour préserver les raisons et tests existants. Dans
  `execute()`, un échec de re-quote retourne bien « re-quote failed » (`bot/execute.js:171-179`).
- **`executor.js` réexporte des symboles de `pricing`.** `buildFeeOverrides`,
  `gasCostInBorrowedToken`, `BPS_DENOMINATOR`, `GAS_COST_MARGIN_BPS`, `GAS_LIMIT_MARGIN_BPS`
  (`bot/executor.js:4-10`, `185-192`) pour compatibilité des tests. À terme, les tests pourront
  importer directement depuis `pricing.js`.
- **Divergence breaker / adaptive.** Un timeout ambigu avec receipt tardif `status=1` est classé
  `SUCCESS` par `index.js` (l'issue adaptative reflète le résultat on-chain), alors que
  `execute.js` a déjà compté un échec breaker (`bot/execute.js:323-335`). C'est voulu : l'adaptive
  et le breaker mesurent des choses différentes (`bot/index.js:245-252`).
- **`resilient.js` ne traverse pas `error.error` / `error.cause` / `error.info.error`.** Un
  `NOT_PROFITABLE` uniquement présent dans ces champs imbriqués serait classé `UNKNOWN`.
  `isNotProfitableError` dans `execute.js` traverse ces chaînes pour la logique de skip
  (`bot/execute.js:114-127`). À noter si un test d'intégration révèle un mauvais classement
  (`bot/resilient.js:64-70`).
- **`throttle.js` ne borne pas la chaîne de promesses.** Si `fn` reste bloqué, les appels suivants
  s'accumulent en mémoire sans limite ni timeout ni annulation. À noter pour une future limite
  `maxQueueSize` ou timeout par appel (`bot/throttle.js:44-78`).

## Ce que le bot ne fait PAS

- **Pas de Timeboost.** L'envoi est un appel `contract.startArbitrage` via le provider ethers
  standard (`bot/execute.js:274-279`) ; aucun chemin Express Lane ni transaction privée. Rappel
  MEV point 2 : environ 200 ms de délai pour les transactions non-Express-Lane.
- **Pas de RPC privé par défaut.** Une seule URL `ARBITRUM_RPC_URL` (`bot/config.js:271`) ; `run.js`
  choisit WebSocket ou HTTP (`bot/run.js:22-42`). Un RPC public ajoute typiquement 100–500 ms par
  appel.
- **Pas de live sans `DRY_RUN=false` + `PRIVATE_KEY` + `CONTRACT_ADDRESS`.** `dryRun` vaut `true`
  par défaut (`bot/config.js:197`), et `maybeExecute()` refuse d'envoyer sans les deux secrets
  (`bot/executor.js:51-64`). Le live exige aussi un prix ETH/USD (`bot/index.js:121-126`).
- **Pas d'apprentissage de code.** L'adaptive ajuste deux paramètres dans des bornes fixes
  (`logs/adaptive.json`), sans jamais modifier la logique. `resilient` et `throttle` bornent
  respectivement le retry et la pression RPC. Aucun de ces modules ne réécrit de code source.
- **Pas de garantie de profit.** Les filtres de `decide()` (`bot/decide.js:93-253`), le `staticCall`
  (`bot/execute.js:231-238`) et les guards réduisent le risque mais ne garantissent rien. Rappel
  MEV point 7 : la configuration actuelle est jugée économiquement défavorable.
