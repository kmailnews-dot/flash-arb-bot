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
