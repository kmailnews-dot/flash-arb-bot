# ADR 0003 — Balayage logarithmique et interpolation locale pour P1-12

- **Statut** : accepté
- **Date** : 2026-11-02
- **Contexte** : P1-12 (balayage logarithmique + régression sur
  la courbe de profit). Point P1 de la liste initiale, jamais
  traité.

## Contexte

`scanPair` (bot/scanner.js) itère sur `pair.tradeSizes`, un
tableau fixe de tailles. `selectBestResult` (bot/index.js)
choisit le résultat avec le `netProfitUsd` le plus élevé (ou
`grossProfit` si USD indisponible). Aucune interpolation :
le meilleur point brut est retenu.

P1-12 demande : « Remplacer `tradeSizes` fixe par un balayage
logarithmique puis une régression sur la courbe de profit.
Critère : la taille retenue est le maximum de la courbe nette. »

## Options

### Option A — Régression quadratique stricte

Ajuster une parabole `y = ax² + bx + c` sur l'ensemble des
points, trouver le maximum analytique `x* = -b/(2a)`. Conforme
au critère, mais sensible aux outliers (un point aberrant
décale le maximum). Nécessite 3 coefficients, plus de code,
plus de tests. Les tailles doivent être exprimées en log pour
que la parabole ait un sens sur une plage large.

### Option B — Interpolation locale sur 3 points (retenue)

Prendre le meilleur point brut `(x1, y1)` et ses deux voisins
immédiats `(x0, y0)` et `(x2, y2)` sur la grille logarithmique.
Interpoler par parabole sur ces 3 points :
`x* = x1 + h/2 * (y0 - y2) / (y0 - 2y1 + y2)`, avec
`h = x1 - x0 = x2 - x1`. Si `y0 - 2y1 + y2 >= 0` (pas de
maximum local) ou si le meilleur point est en bord de grille,
garder `x1`. Si un des 3 points a une erreur
(`QUOTE_STALE`, `DEPTH_EXCEEDED`, etc.), garder `x1`. Borne
finale : `min(x*, bounds.maxTradeSize)`.

Robuste aux outliers (n'utilise que les 3 points locaux),
simple, testable. Satisfait le critère « maximum de la courbe
nette » au sens local.

### Option C — Balayage logarithmique sans interpolation

Générer une grille logarithmique plus fine et prendre le
meilleur point brut. Plus simple, mais ne satisfait pas le
critère « maximum de la courbe nette » : on reste sur un point
de grille, pas sur un maximum interpolé.

## Décision

Option B.

## Conséquences

- Positives :
  - Robuste aux outliers (3 points locaux).
  - Simple à tester (une fonction pure dans bot/pricing.js).
  - Le critère « maximum de la courbe nette » est respecté au
    sens local.
  - La configuration `tradeSizes` legacy reste supportée (si
    `logSweep` n'est pas fourni).
  - Le champ `logSweep` est optionnel par paire : `majors` peut
    utiliser une grille serrée [0.01, 0.1], `longtail` une
    grille large [0.01, 1].

- Négatives :
  - Deux modes de config (`tradeSizes` vs `logSweep`) à
    maintenir et tester.
  - L'interpolation peut produire un `tradeSize` non
    exactement sur la grille (ex. 0.037 au lieu de 0.03 ou
    0.1). C'est voulu : c'est le maximum local interpolé.
  - Pas de garantie que le maximum global soit trouvé si la
    courbe est multimodale. Acceptable : les paires sont
    supposées unimodales (profit croît puis décroît avec la
    taille).

- Neutres :
  - Aucune modification de `selectBestResult` : il reçoit
    toujours un tableau trié par `grossProfit` décroissant.
  - Le résultat interpolé est marqué `interpolated: true` pour
    traçabilité.

## Conditions de réexamen

1. Si les tests d'intégration révèlent que l'interpolation
   locale produit des résultats aberrants sur des paires
   réelles → réévaluer l'Option A.
2. Si un audit P1-12 externe demande une régression stricte
   → réévaluer.
3. Si les paires deviennent multimodales (multi-hop, P1-18)
   → l'interpolation locale devra être étendue ou remplacée.

## Références

- bot/scanner.js (scanPair, scanTradeSize, isTradeSizeWithinDepth)
- bot/pricing.js (withSlippage, gasCostInBorrowedToken)
- bot/config.js (PROFILE_BOUNDS, validatePairs)
- bot/index.js (selectBestResult)
