# ADR 0004 — Circuit breaker sur taux d'erreurs RPC

- **Statut** : accepté
- **Date** : 2026-11-02
- **Contexte** : D3-breaker-bis-c (détection d'un taux
  d'erreurs RPC anormal sur fenêtre). Dernière dette
  non-bloquée des D1–D6, après P1-12.

## Contexte

`rpcErrors` est un compteur local dans `main()`
(bot/index.js). Il est incrémenté pour chaque `result.error`
qui est un objet (vraie erreur RPC, pas un filtre qualité
QUOTE_STALE / DEPTH_EXCEEDED, voir D4-bis). Il est remis à
zéro à chaque cycle. Il est utilisé pour :

- Le warning `[RPC ERRORS]` si `rpcErrors > maxRpcErrorsPerScan`.
- L'`exitCode` (`1` si `rpcErrors > maxRpcErrorsPerScan` ou
  `scanned === 0`).

Le circuit breaker (`checkCircuitBreaker`, bot/guards.js) ne
voit pas ce compteur. Il ouvre sur 4 conditions :
consecutiveFailures, revertRate, unknownRate, drawdown. Aucune
de ces conditions ne reflète un RPC instable.

Conséquence : un RPC qui échoue 1 cycle sur 2 (50 % d'erreurs)
mais dont les erreurs sont absorbées par `scanPair` (résultats
avec `error`) ne déclenchera jamais le breaker. Le bot
continuera à scanner indéfiniment avec un RPC dégradé.

## Options

### Option A — Compteur global non persisté

Garder `rpcErrors` local mais l'utiliser dans
`checkCircuitBreaker` via un paramètre. Simple, mais ne
survit pas au redémarrage du process. Un cycle de 50 %
d'erreurs ne suffit pas à ouvrir le breaker (il faut un
historique).

### Option B — Persistance d'un historique (retenue)

Nouveau fichier `logs/rpc_errors.json` au format suivant :

    {
      "version": 1,
      "cycles": [
        { "errors": 3, "total": 10, "at": 1700000000000 },
        { "errors": 0, "total": 10, "at": 1700000300000 }
      ]
    }

`recordRpcCycle({ filePath, errors, total, at })`
(bot/guards.js) :

- Lit le fichier, ajoute le cycle, tronque à `windowSize`
  (défaut 10).
- Écrit atomiquement (tmp + fsync + rename).

`checkRpcErrorRate({ filePath, windowSize, threshold, now })`
(bot/guards.js) :

- Lit le fichier, calcule `sum(errors) / sum(total)` sur la
  fenêtre.
- Si `sum(total) === 0`, retourne `{ ok: true, rate: 0, samples: 0 }`.
- Si `rate > threshold`, retourne `{ ok: false, rate, samples }`.
- Sinon `{ ok: true, rate, samples }`.

`checkCircuitBreaker` appelle `checkRpcErrorRate` en plus des
4 conditions existantes. Config : `rpcErrorRateWindowSize`
(défaut 10), `rpcErrorRateThreshold` (défaut 0.5).

### Option C — Compteur global persisté, sans fenêtre

Persister `rpcErrors` et `total` cumulés, sans fenêtre. Plus
simple, mais ne reflète pas l'état actuel du RPC : un RPC qui
a échoué 100 fois en 1h puis 0 fois depuis 2h resterait
bloquant.

## Décision

Option B.

## Conséquences

- Positives :
  - Détecte un RPC dégradé sur une fenêtre glissante.
  - Survit au redémarrage du process (persistance).
  - Fail-open sur fichier absent ou vide (pas de faux positif
    au démarrage).
  - Configurable (windowSize, threshold).
  - Aligné sur le pattern existant de `circuit_breaker.json`.

- Négatives :
  - Nouveau fichier d'état à maintenir (`logs/rpc_errors.json`).
  - Nécessite un `recordRpcCycle` appelé à chaque cycle dans
    `bot/index.js`.
  - La fenêtre est un tableau, donc O(windowSize) en lecture
    et écriture. Acceptable (10 cycles par défaut).

- Neutres :
  - Le warning `[RPC ERRORS]` existant reste inchangé.
  - L'`exitCode` existant reste inchangé.
  - Le breaker reste fail-closed : si `checkRpcErrorRate` throw
    (fichier corrompu), le breaker s'ouvre.

## Conditions de réexamen

1. Si les tests d'intégration révèlent que 10 cycles est trop
   court (faux positifs) → augmenter `rpcErrorRateWindowSize`.
2. Si 10 cycles est trop long (RPC dégradé non détecté à
   temps) → diminuer.
3. Si le seuil 0.5 est trop permissif ou trop strict → ajuster.

## Références

- bot/guards.js (checkCircuitBreaker, recordFailure, addGasSpent)
- bot/index.js (main, rpcErrors)
- bot/config.js (maxRpcErrorsPerScan, maxQuoteAgeMs)
- docs/PRIORITES.md (Suivi des dettes post-audit)
- ADR 0001 (nonce manager)
- ADR 0002 (gaz drawdown, si créé)
- ADR 0003 (log sweep)

---
