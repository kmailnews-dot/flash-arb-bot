# PRIORITÉS — flash-arb-bot

Date : 31 octobre 2026
Source : liste fournie par l'utilisateur, corrigée après
authentification du contrat à HEAD 5337cb3 (P0 fermé côté code).

> **Avertissement.** La liste initiale a été rédigée sans lecture
> du contrat. Les statuts P0 ci-dessous sont authentifiés à HEAD.
> Ne pas appliquer un point sans relire son statut. P1-P5 sont
> listés tels quels, non authentifiés.

## P0 — Authentifié

| # | Statut | Effort | Constat | Référence | Critère d'acceptation |
|---|---|---|---|---|---|
| P0-1 | FERMÉ | — | msg.sender==POOL et initiator==address(this) déjà en tête de executeOperation | contracts/FlashArbExecutor.sol:83-84 | Aucun code à écrire |
| P0-2 | NON APPLICABLE | — | sqrtPriceLimitX96=0 n'est pas un bug : le slippage est borné par amountOutMinimum (P0-3) | contracts/FlashArbExecutor.sol:164 | Aucune action |
| P0-3 | FERMÉ | S | require ZERO_MIN_OUT dans _swap ; buildParams passe minAmountOut 1n | contracts/FlashArbExecutor.sol:142-167 ; test/FlashArbExecutor.test.js:303-328 | require(leg.minAmountOut > 0, "ZERO_MIN_OUT") dans _swap, test négatif |
| P0-4 | FERMÉ | M | minProfit absolu et minProfitBps appliqués on-chain dans _settle ; filtre off-chain dans bot/decide.js | contracts/FlashArbExecutor.sol:40-48,113-140 ; bot/execute.js ; bot/executor.js ; test/FlashArbExecutor.test.js:367-418 | Ajouter minProfitBps dans ArbParams ; require(profit >= minProfit && profit*10000 >= amount*minProfitBps) ; ABI + bot/execute.js + bot/executor.js + tests |
| P0-5 | DÉCLASSÉ P2 | — | Contrôle require(block.timestamp <= arb.deadline) existe à :71 et :87 ; la non-propagation aux routers n'est pas un bug démontré | contracts/FlashArbExecutor.sol:71,87,151,161 | Aucune action en P0 |
| P0-6 | FERMÉ | S | Approve POOL paresseux (max, une fois par token) ; approves router par trade conservés | contracts/FlashArbExecutor.sol:130-133,144 ; test/FlashArbExecutor.test.js:330-365 | mapping(address => bool) approved + forceApprove(POOL, max) au premier usage par token ; approves router conservés ; test |
| P0-7 | FERMÉ | — | Profit payé en ERC-20 via safeTransfer(owner(), profit) | contracts/FlashArbExecutor.sol:135-137 | Aucun code à écrire |
| P0-8 | FERMÉ | S | Pausable ajouté ; whenNotPaused sur startArbitrage uniquement ; pause/unpause onlyOwner | contracts/FlashArbExecutor.sol:65-74,99-105 ; test/FlashArbExecutor.test.js:244-301 | whenNotPaused sur startArbitrage UNIQUEMENT (pas sur executeOperation, pas sur sweep*) ; tests positif+négatif |
| P0-9 | FERMÉ | S | Revue de clôture P0 : 13 références corrigées, test positif minProfitBps ajouté, doc à jour | AGENTS.md §8, docs/PRIORITES.md, test/FlashArbExecutor.test.js:393-418 | npx hardhat test vert (202 passing) |
| P0-10 | FERMÉ | S | Test négatif CALLER_NOT_POOL ajouté | test/FlashArbExecutor.test.js:420-432 | Test : EOA appelle executeOperation → revert("CALLER_NOT_POOL") |

Ordre d'exécution : P0-8 → P0-3 → P0-6 → P0-4 → P0-10 → P0-9.
Raison : du plus simple au plus invasif. P0-4 en dernier des
corrections (touche contrat+ABI+bot+tests). P0-9 en revue finale.

## P1 à P5 — non authentifiés

Note : ces sections reproduisent la liste initiale. Elles n'ont
pas été vérifiées contre le code à HEAD. Ne pas appliquer sans
authentification préalable.

### P1 — Arithmétique de rentabilité

10. Scinder la config en deux profils : majors et longtail, deux PAIRS_CONFIG_JSON distincts. Fichiers : .env.example, bot/. Effort M. Critère : chaque profil a son propre plancher de bps et son propre plafond de taille.
11. Bannir le V2 30 bps des jambes majors → V3 100 contre 500, ou 100 contre 100. Fichier : PAIRS_CONFIG_JSON. Effort S. Critère : plancher de coût calculé ≤ 12 bps sur toutes les entrées majors.
12. Remplacer tradeSizes fixe par un balayage logarithmique puis une régression sur la courbe de profit. Fichier : bot/. Effort L. Critère : la taille retenue est le maximum de la courbe nette.
13. MIN_PROFIT_USD devient max(plancher_absolu, gas_estimé × k), k ≈ 3. Fichier : bot/. Effort S. Critère : sur une paire USDC à 50 $, le seuil descend sous 0,10 $.
14. MIN_PROFIT_BPS par paire : 10-15 sur majors, 60-100 sur longtail. Fichier : PAIRS_CONFIG_JSON. Effort S. Critère : plus de valeur globale unique.
15. Plafonner la taille à 0,5 % de la profondeur de la pool intermédiaire. Fichier : bot/. Effort M. Critère : aucune cotation au-delà du plafond sur une pool mince.
16. Filtre de coût dans validatePairs : rejeter si premium + feeA + feeB ≥ écart médian de la paire. Fichier : bot/. Effort M. Critère : une entrée V2/V2 sur un major est rejetée au démarrage avec un message explicite.
17. Contrôle pré-vol du token intermédiaire : staticCall d'un transfert, comparaison du delta de balance. Fichier : bot/. Effort M. Critère : un token à 5 % de taxe est rejeté avant la première cotation.
18. Support multi-hop (chemin de jambes) pour les routes triangulaires. Fichiers : contrat + bot/. Effort L. Critère : une route à 3 jambes s'exécute et la garde minProfit reste identique.

### P2 — Latence

19. Sortir le mode live du cron GitHub → run.js en boucle sur VPS ou conteneur always-on. Fichiers : .github/workflows/live.yml, doc. Effort M. Critère : aucune exécution live planifiée par Actions.
20. Coter, simuler et soumettre contre le même bloc, dans cet ordre. Fichier : bot/. Effort M. Critère : le tag de bloc de la simulation égale celui de la cotation.
21. Cotations en parallèle mais exécution immédiate sur la première route profitable, sans attendre les autres. Fichier : bot/. Effort M. Critère : le délai cotation→soumission est indépendant du nombre de paires.
22. Provider WebSocket par défaut en mode live. Fichier : bot/run.js. Effort S. Critère : ws:// imposé quand DRY_RUN=false.
23. Pré-chauffer en continu les cotations des 3 paires les plus actives. Fichier : bot/. Effort M. Critère : cache de cotation < 1 bloc d'âge sur ces paires.
24. Timeboost (voie express Arbitrum) — seulement après P1 stabilisé. Fichier : bot/. Effort L. Critère : mesure du gain d'écart réalisé avant/après.

### P3 — Exploitation et garde-fous

25. concurrency: group: live-${{ network }} sur le workflow live. Fichier : live.yml. Effort S. Critère : deux déclenchements simultanés : le second attend.
26. Sortir gas_spent.json et circuit_breaker.json du cache éphémère (gist privé ou disque VPS). Fichier : bot/guards.js. Effort M. Critère : un run après expiration de cache conserve le compteur.
27. Plafond de perte USD journalier, en plus du plafond de gaz. Fichier : bot/guards.js. Effort M. Critère : nouveau code de skip DAILY_LOSS_LIMIT.
28. Verrou d'instance (single-flight) sur le cycle de scan. Fichier : bot/. Effort S. Critère : deux processus concurrents : le second sort proprement.
29. Alerte explicite quand le disjoncteur s'ouvre, pas seulement un log. Fichier : bot/guards.js. Effort S. Critère : message dédié en tête de log + compteur d'échecs consécutifs affiché.

### P4 — Mesure et calibration

30. Logger l'écart quoté en bps et l'écart réalisé au fill pour chaque tentative live. Fichier : bot/. Effort S. Critère : les deux champs présents dans chaque ligne du JSONL.
31. Compteur « aurait été rentable » sur les cycles dry-run. Fichier : bot/. Effort S. Critère : agrégat par paire disponible en fin de cycle.
32. Rapport quotidien : ratio écart réalisé/quoté, taux de revert, profit net cumulé. Fichier : script. Effort M. Critère : sortie lisible sans jq.

### P5 — Dette

33. Corriger le message de log mixte « N erreurs sur ce cycle ». Fichier : bot/. Effort S.
34. Réaligner les tailles de l'exemple .env.example sur les deux profils du point 10. Fichier : .env.example. Effort S.
35. Ajouter test:fork en nightly CI (bloc épinglé, RPC archive). Fichier : .github/workflows/. Effort S.

### À ne pas faire

- SwapRouter02 en jambe V3 — sélecteur incompatible, déjà rejeté, ne pas rouvrir.
- Passer PRIVATE_KEY au scan planifié.
- Augmenter les tailles sans le plafond de profondeur du point 15.
- Attaquer le multi-hop (18) avant que les P0 soient fermés.
- Toucher à Timeboost avant d'avoir trois semaines de données du point 30.

## Ce qui n'est pas dans la liste initiale

- P0-10 (test négatif CALLER_NOT_POOL) : ajouté après authentification. P0-1 est fermé ; CALLER_NOT_POOL est couvert, mais UNTRUSTED_INITIATOR reste sans test négatif direct.
- P0-9 (revue de clôture) : précisé comme revue, pas écriture de tests.
- P0-4 : reformulé en double contrôle on-chain (minProfit absolu + minProfitBps), pas simple passage bps.
- P0-2, P0-5 : sortis de P0 (non applicables, contrôle existant).
- P0-1, P0-7 : fermés (déjà faits).

---

## Suivi P1-XX (post-audit)

Statuts consolidés après l'audit complet du 1er novembre 2026.
Les listes numérotées 10–18 ci-dessus restent la référence
historique de la matrice initiale.

| # | Statut | Commit | Note |
|---|---|---|---|
| P1-10 | FERMÉ | e35ae5c | profils majors/longtail par paire |
| P1-11 | FERMÉ | f40cae8 | bannir V2 30 bps des majors |
| P1-13 | FERMÉ | a7837f3 | MIN_PROFIT_USD × gaz (GAS_PROFIT_MULTIPLIER = 3) |
| P1-14 | FERMÉ | 19205a2 | minProfitBps par paire |
| P1-15 | FERMÉ | 2c3f5ae | plafond de profondeur 0,5 % par quote d'impact |
| P1-16 | FERMÉ | 7f1af08 | feeBps par jambe + maxTotalFeeBps |
| P1-17 | REPORTÉ | — | irréalisable avec eth_call seul, sans helper on-chain |
| P1-12 | À FAIRE | — | balayage logarithmique + régression |
| P1-18 | À FAIRE | — | multi-hop |
| P1-10-bis | NON PLANIFIÉ | — | adaptive par profil (tradeSizeFactor global) |
| P1-16-bis | NON PLANIFIÉ | — | écart médian dynamique |

## Suivi D0–D12 (issus de l'audit)

Défauts structurants identifiés par l'audit des 3 lots
(lecture seule). Aucun n'est critique au sens « perte de fonds
imminente en DRY_RUN ». Chacun fera l'objet d'un point dédié.

| # | Statut | Commit | Note |
|---|---|---|---|
| D7 | FERMÉ | e35ae5c | max(pair.minProfitBps, config.effectiveMinProfitBps) dans decide/execute/executor |
| D7-bis | À FAIRE | — | extraire effectiveMinProfitBps(pair, config) dans bot/pricing.js |
| D10 | À FAIRE | — | fix test/ForkArbitrum.test.js (minAmountOut, minProfitBps) |
| D11 | À FAIRE | — | MIN_PROFIT_BPS transmis dans live.yml et scan.yml |
| D12 | À FAIRE | — | EXPECTED_CHAIN_ID=31337 dans seedLocalMocks + README |
| D1 | À FAIRE | — | journal d'exécution durable (machine à états tx) |
| D2 | À FAIRE | — | classification ethers v6 complète (CALL_EXCEPTION, NONCE_EXPIRED, REPLACEMENT_UNDERPRICED, TRANSACTION_REPLACED) |
| D3 | À FAIRE | — | P&L réalisé + circuit breaker étendu (drawdown, RPC, gaz) |
| D4 | À FAIRE | — | blockTag commun + TTL explicite |
| D5 | À FAIRE | — | coût L1/calldata dans le calcul de profit |
| D6 | À FAIRE | — | une seule source de premium Aave (scanner + decide + execute) |
| D8 | À FAIRE | — | owner() dans FLASH_ARB_EXECUTOR_ABI |
| D9 | À FAIRE | — | seuils absents = rejet explicite dans decide |

---

## Suivi des dettes post-audit (D1–D6)

> **Note.** D3-PnL-bis et D3-PnL-ter sont fermées par le commit
> `abb6fac` (F-05-A/B), mais restent listées pour traçabilité
> historique. Ne pas les rouvrir sans nouvelle authentification.

Défauts identifiés pendant la remédiation de l'audit (lots 1–3)
mais non corrigés dans les commits fermés D1–D6. Chacun fera
l'objet d'un point dédié ou d'une acceptation écrite.

| # | Statut | Commit | Note |
|---|---|---|---|
| D1-bis | À FAIRE | — | catch ambigu sans txHash : ne pas requalifier DROPPED, utiliser getTransactionCount |
| D3-PnL-bis | FERMÉ | abb6fac | parser receipt.logs dans le catch err.receipt (fermé par F-05-A) |
| D3-PnL-ter | FERMÉ | abb6fac | lateReceipt.status === 0 : écrire une ligne PnL REVERTED (fermé par F-05-B) |
| D3-breaker-bis | À FAIRE | — | détection gaz anormal (drawdown, RPC, gaz) |
| D3-breaker-ter | DOCUMENTÉ | — | garde revertWindowFull/unknownWindowFull (fenêtre partielle). Voir bot/ARCHITECTURE.md. |
| D3-breaker-quater | DOCUMENTÉ | — | rate non réévalué après expiration du cooldown. Voir bot/ARCHITECTURE.md. |
| D3-breaker-quinquies | FERMÉ | 477ced5 | distinguer ENOENT de STATE_FILE_CORRUPT dans le breaker (déjà implémenté dans readState) |
| D3-breaker-sexies | À FAIRE | — | tests validation config breaker (4 options) |
| D4-bis | À FAIRE | — | QUOTE_STALE et DEPTH_EXCEEDED ne doivent pas incrémenter rpcErrors (bot/index.js) |
| D4-ter | DOCUMENTÉ | — | blockTag non propagé à execute.js (re-quote runtime reste "latest"). Voir bot/ARCHITECTURE.md. |
| D5-bis | DOCUMENTÉ | — | gasPaidWei (total L2+L1) vs l1FeeWei (détail L1) : ne pas additionner. Voir bot/ARCHITECTURE.md. |
| D5-ter | À FAIRE | — | calibrer L1_COST_MULTIPLIER_BPS sur receipts réels (données de production requises) |
| D6a-bis | FERMÉ | c3f1e1b | tests validation maxQuoteAgeMs et L1_COST_MULTIPLIER_BPS |
| D6-bis | FERMÉ | 18d2927 | test unitaire direct de readAaveFlashLoanPremium (3 chemins) |
| D1-ter | À FAIRE | — | fallback getTransactionCount dans reconcilePendingExecutions pour les records UNKNOWN sans txHash |
| D3-breaker-bis-c | À FAIRE | — | détection d'un taux d'erreurs RPC anormal sur fenêtre (nécessite persistance) |
| D3-breaker-bis-b | À FAIRE | — | détection d'un gaz anormal (médiane gasPrice sur N cycles, ADR requis) |

---

## F-05-C — red team et clôture (commit 0e5960a)

### Périmètre

Le gestionnaire de nonce (`bot/nonce.js`, ADR
`docs/adr/0001-nonce-manager.md`) est intégré à
`bot/execute.js`. Il n'est actif que si `config.dryRun === false`
ET `provider.getTransactionCount` est une fonction. En
`DRY_RUN=true` (défaut, CI, scan.yml), le comportement est
strictement inchangé.

### Scénarios adverses examinés

| Scénario | Statut | Couverture |
|---|---|---|
| Panne après `SIGNED` mais avant envoi | Couvert | `reconcilePendingExecutions` → `DROPPED` (crash before submit) |
| Panne après `SUBMITTED` | Couvert | `reconcilePendingExecutions` → `CONFIRMED`/`REVERTED` par hash |
| RPC menteur (retourne un mauvais nonce) | Partiel | `manager.next()` accepte le nonce retourné ; pas de vérification croisée. Ticket `F-05-C-bis`. |
| Concurrence sur le même `(provider, address)` | Couvert | `WeakMap<provider, Map<address, manager>>` + `manager.next()` sérialise le cache |
| Réorg entre envoi et receipt | Couvert | `waitForReceipt` + `lateReceipt` + `reconcilePendingExecutions` |
| Double soumission (deux process) | Hors périmètre | Le manager est en mémoire ; deux process auraient deux caches. Non traité (process unique attendu). |
| `NONCE_EXPIRED` après envoi | Couvert fail-closed | `REJECTED_BEFORE_ACCEPTANCE` libère la réservation, breaker non incrémenté |
| `NONCE_EXPIRED` avant envoi (`estimateGas`) | **Ouvert** | `F-05-C-bis` : pas de `manager.reset()`. Le prochain `next()` utilise l'ancien cache. |
| Redémarrage process avec nonce managé | Couvert | Le manager relit `getTransactionCount(addr, "pending")` au premier `next()` |
| Journal et nonce managé incohérents | Partiel | `tx.nonce` est journalisé après envoi ; le manager n'est pas réconcilié avec le journal. Ticket `F-05-C-ter`. |

### Dette F-05-C-bis — resynchronisation sur `NONCE_EXPIRED`

**Statut** : ouverte.

**Cas réel** : catch d'envoi `execute.js:402` (branche
`REJECTED_BEFORE_ACCEPTANCE`) et catch `estimateGas`
`executor.js:110-124`.

**Impact** : en cas de nonce désynchronisé (rare), le prochain
`next()` utilise l'ancien cache jusqu'à épuisement ou
redémarrage. Fail-closed : `startArbitrage` échoue avec
`NONCE_EXPIRED`, réservation libérée, breaker non incrémenté.
Le prochain démarrage du process resynchronise.

**Correctif futur** : ajouter `manager.reset()` dans le catch
`REJECTED_BEFORE_ACCEPTANCE` quand `err.code === "NONCE_EXPIRED"`,
avec un test discriminant.

### Dette F-05-C-ter — réconciliation du nonce managé avec le journal

**Statut** : ouverte.

**Description** : le journal (`SIGNED`/`SUBMITTED`) contient
`tx.nonce` après envoi, mais le manager n'est pas réconcilié avec
le journal au-delà de ce champ. Un nonce pourrait diverger si le
journal contient un nonce que le manager ignore (par exemple,
après une réconciliation manuelle).

**Correctif futur** : optionnel. La réconciliation par hash
(`reconcilePendingExecutions`) couvre la sécurité du capital.
Le manager ne sert qu'à éviter les collisions de nonce. Une
divergence journal/manager ne peut pas faire perdre de fonds
(le `nonce` du journal est purement informatif).

### Clôture

`F-05-C` est **fermé** pour le mode réel, avec les deux dettes
documentées ci-dessus. En `DRY_RUN=true`, comportement
strictement inchangé.

---
