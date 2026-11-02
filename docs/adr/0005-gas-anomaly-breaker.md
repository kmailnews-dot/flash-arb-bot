# ADR 0005 — Circuit breaker sur gaz anormal

- **Statut** : accepté
- **Date** : 2026-11-02
- **Contexte** : D3-breaker-bis-b (détection d'un gaz anormal).
  Dernière dette non-bloquée des D1–D6, après D3-breaker-bis-c
  et P1-12.

## Contexte

Le circuit breaker (`checkCircuitBreaker`, bot/guards.js) ouvre
sur 5 conditions : consecutiveFailures, revertRate,
unknownRate, gas drawdown, RPC error rate. Aucune ne reflète un
gasPrice anormal.

Conséquence : si le gasPrice Arbitrum s'envole (congestion,
spam, incident réseau), le bot continue à scanner et à envoyer
des transactions à un coût prohibitif. Le drawdown finira par
ouvrir le breaker, mais après plusieurs transactions coûteuses.
Un breaker sur gaz anormal ouvrirait **avant** la première
transaction coûteuse.

## Options

### Option A — Seuil absolu sur le gasPrice

Ouvrir le breaker si `gasPrice > seuilAbsoluGwei` (ex. 50
gwei). Simple, mais ne s'adapte pas au régime de gaz normal
d'Arbitrum, qui peut être de 0.01 gwei en temps calme et de 1
gwei en congestion modérée. Un seuil absolu est soit trop
permissif (laisse passer des gasPrice 100× la normale), soit
trop strict (bloque en cas de congestion normale).

### Option B — Médiane glissante (retenue)

Nouveau fichier `logs/gas_history.json` au format suivant :

    {
      "version": 1,
      "samples": [
        { "gasPriceWei": "1000000000", "at": 1700000000000 },
        { "gasPriceWei": "1200000000", "at": 1700000300000 }
      ]
    }

`recordGasSample({ filePath, gasPriceWei, at })`
(bot/guards.js) :

- Lit le fichier, ajoute l'échantillon, tronque à `windowSize`
  (défaut 20).
- Écrit atomiquement (tmp + fsync + rename).

`checkGasAnomaly({ filePath, windowSize, multiplier, now })`
(bot/guards.js) :

- Lit le fichier, filtre les échantillons avec `at <= now`.
- Si moins de `minSamples` (défaut 5) échantillons, retourne
  `{ ok: true, reason: "insufficient samples" }` (fail-open).
- Calcule la médiane des `gasPriceWei`.
- Si le dernier échantillon > `multiplier × médiane`, retourne
  `{ ok: false, median, last, ratio }`.
- Sinon `{ ok: true, median, last, ratio }`.

`checkCircuitBreaker` appelle `checkGasAnomaly` en plus des 5
conditions existantes. Config : `gasAnomalyWindowSize` (défaut
20), `gasAnomalyMultiplier` (défaut 3), `gasHistoryPath`
(défaut logs/gas_history.json), `gasAnomalyMinSamples` (défaut
5).

### Option C — Percentile

Calculer le 95e percentile sur la fenêtre, ouvrir si le dernier
échantillon dépasse. Plus robuste aux outliers que la médiane
stricte, mais plus complexe à implémenter et à tester. La
médiane est suffisante pour détecter un gaz anormal (facteur
3×).

## Décision

Option B.

## Conséquences

- Positives :
  - Détecte un gaz anormal sur une fenêtre glissante.
  - Survit au redémarrage du process (persistance).
  - Fail-open sur fichier absent, échantillons insuffisants ou
    schéma invalide (pas de faux positif au démarrage).
  - Configurable (windowSize, multiplier, minSamples).
  - Aligné sur le pattern existant de `rpc_errors.json` (ADR
    0004).

- Négatives :
  - Nouveau fichier d'état à maintenir (`logs/gas_history.json`).
  - Nécessite un `recordGasSample` appelé à chaque cycle dans
    `bot/index.js`, avec `gasPriceWei`.
  - La médiane est O(n log n) en lecture. Acceptable (20
    échantillons par défaut).

- Neutres :
  - Le breaker reste fail-closed : si `checkGasAnomaly` throw
    (fichier corrompu), le breaker s'ouvre.
  - Le warning `[GAS ANOMALY]` existant (s'il est ajouté) reste
    inchangé.

## Conditions de réexamen

1. Si les tests d'intégration révèlent que 20 échantillons est
   trop court (faux positifs) → augmenter
   `gasAnomalyWindowSize`.
2. Si le multiplicateur 3× est trop permissif ou trop strict →
   ajuster.
3. Si Arbitrum change de régime de gaz (EIP-1559, Timeboost) →
   réévaluer.

## Références

- bot/guards.js (checkCircuitBreaker, recordFailure, addGasSpent)
- bot/index.js (main, gasPriceWei)
- bot/config.js (gasPriceBufferPct, maxGasLimit)
- docs/PRIORITES.md (Suivi des dettes post-audit)
- ADR 0001 (nonce manager)
- ADR 0003 (log sweep)
- ADR 0004 (RPC error rate breaker)
