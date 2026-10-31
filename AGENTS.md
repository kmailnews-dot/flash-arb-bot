# AGENTS.md — Règles de fonctionnement pour OpenCode

Ces règles s'appliquent à toutes les sessions sur ce projet. Lis-les avant toute modification.

## 1. AVANT TOUTE MODIFICATION
- Lis le fichier concerné en entier, pas seulement les lignes citées.
- Vérifie que l'état décrit dans le message correspond au code réel.
- Si un écart existe, signale-le AVANT de modifier.
- Si un audit externe (Claude ou autre) décrit un bug ou un état du code, vérifier le fichier réel via `git show <commit>:<path>` avant de le croire. Ne jamais fournir un résumé ou une reconstitution à un auditeur : il lira un texte différent du code réel.

## 2. MODIFICATIONS
- Fais des diffs chirurgicaux. Ne réécris jamais un fichier entier.
- Ne touche qu'aux lignes nécessaires pour le point demandé.
- Ne "profite" pas d'une modification pour en faire une autre.

## 3. ORDRE DES OPÉRATIONS
- Si un calcul dépend d'une valeur, calcule la valeur AVANT d'utiliser le résultat.
- Ne mute jamais un objet après l'avoir utilisé dans une simulation ou une décision.
- Construis un objet final distinct si tu dois le modifier.

## 4. TESTS
- Après chaque modification, lance `npx hardhat test`.
- Si un test existant casse, explique pourquoi AVANT de le modifier.
- Ajoute les tests demandés, pas plus.

## 5. SÉCURITÉ
- Ne jamais afficher de secret (clé privée, URL RPC, token).
- Ne jamais commit ni push sans accord explicite.
- Ne jamais modifier `contracts/FlashArbExecutor.sol` sans accord explicite.
- DRY_RUN=true par défaut. Aucune transaction réelle.

## 6. FORMAT DE RÉPONSE
- Constat (fichier:ligne) → Diff → `npx hardhat test` → Risque résiduel.
- Pas d'explication inutile. Pas de "je vais faire". Fais, montre, arrête-toi.
- Si tu n'es pas sûr d'un point, dis-le explicitement au lieu d'inventer.

## 7. ARRÊT
- Traite un seul point à la fois.
- Arrête-toi après chaque point pour validation.
- Ne passe pas au point suivant sans feu vert.

## 8. CONTEXTE DU PROJET (mis à jour manuellement)
- **Stack** : Solidity ^0.8.20, Node.js 20, Hardhat, ethers v6, Aave V3, Uniswap V3 (SwapRouter original uniquement, jamais SwapRouter02), SushiSwap V2.
- **Réseau** : Arbitrum One (42161), Arbitrum Sepolia (421614).
- **Dernier commit** : cf27513.
- **Prochaine étape** : F-06 (timeout RPC dans txInFlight).
- **Tests** : 195 passing, 2 pending (tests fork), 0 failing.

## 9. ARCHITECTURE
- Carte du bot : bot/ARCHITECTURE.md (flux, modules, invariants, pièges).
- Contrat de types : bot/domain.js (aucun export runtime).
- Modules clés :
  - bot/pricing.js — arithmétique pure (slippage, gaz, fee overrides).
  - bot/decide.js — décision pure `decide()` → `Decision`, aucun I/O.
  - bot/execute.js — exécution (guards, envoi, receipt, réconciliation).
  - bot/executor.js — façade `maybeExecute` (dry-run, estimate, re-quote,
    decide, execute) + verrou mono-transaction `txInFlight`.
  - bot/guards.js — checks fail-closed + état gaz/breaker.
  - bot/index.js — un cycle (`main`).
  - bot/run.js — process persistant (`run`).
  - bot/adaptive.js — seuils adaptatifs bornés (MIN_PROFIT_BPS, taille de trade).
  - bot/resilient.js — classification d'erreur + retry borné + backoff.
  - bot/throttle.js — sérialisation RPC + intervalle minimum.
- Avant de modifier du code, lire bot/ARCHITECTURE.md en plus du fichier concerné.
- `bot/executor.js` réexporte `buildFeeOverrides`, `gasCostInBorrowedToken`,
  `BPS_DENOMINATOR`, `GAS_COST_MARGIN_BPS`, `GAS_LIMIT_MARGIN_BPS`
  depuis `bot/pricing.js` pour compatibilité des tests existants.
