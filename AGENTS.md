# AGENTS.md — Règles de fonctionnement pour OpenCode

Ces règles s'appliquent à toutes les sessions sur ce projet. Lis-les avant toute modification.

## 1. AVANT TOUTE MODIFICATION
- Lis le fichier concerné en entier, pas seulement les lignes citées.
- Vérifie que l'état décrit dans le message correspond au code réel.
- Si un écart existe, signale-le AVANT de modifier.

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
- **Dernier commit** : ce5042a (P1-9b-3: overrides undici 6.29.1).
- **Prochaine étape** : Aucune (projet stable, 0 high, 0 critical, prêt pour DRY_RUN ou live).
- **Tests** : 104 passing, 2 pending (tests fork).
