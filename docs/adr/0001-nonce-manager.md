# ADR 0001 — Gestionnaire de nonce pour F-05-C

- **Statut** : accepté
- **Date** : 2026-11-01
- **Contexte** : F-05-C (gestionnaire de nonce unique, section 8
  du rôle), dernier défaut F-05 ouvert après les commits abb6fac
  (F-05-A/B) et 8aafe7c (F-05-E).

## Contexte

La machine à états des transactions (bot/execute.js,
reconcilePendingExecutions, lateReceipt) réconcilie les
transactions par hash après un timeout ou un redémarrage. Cette
atténuation couvre le risque pratique en DRY_RUN=true, mais
§8 exige un gestionnaire de nonce unique, avec politique de
remplacement explicite et détection de transaction bloquée.

Aucun `getTransactionCount` n'est appelé dans bot/execute.js,
bot/executor.js, bot/index.js, bot/guards.js, bot/persist.js,
bot/decide.js. Le champ `nonce` du journal n'est écrit
qu'après `contract.startArbitrage(...)`, jamais lu avant.

## Options

### Option A — Gestionnaire complet, partout

Implémentation dans tous les modes (dry-run et réel). Conforme
§8, mais ajoute du code non exercé en DRY_RUN=true (pas
d'envoi), difficile à valider, risque de régression sur les
276 tests existants.

### Option B — Acceptation documentée, pas de code

Section dans docs/PRIORITES.md actant que la réconciliation par
hash couvre le risque, et reportant le gestionnaire à un point
ultérieur. Effort minimal, mais non conforme §8 : le dépôt
resterait en violation de sa propre spécification.

### Option C — Hybride (retenue)

Nouveau module bot/nonce.js, isolé, testé unitairement.
Activé UNIQUEMENT quand config.dryRun === false. En
DRY_RUN=true, comportement strictement inchangé.

## Décision

Option C.

## Conséquences

- Positives :
  - Conforme §8 en production réelle.
  - Zéro régression en DRY_RUN=true : CI, scan.yml, tests
    existants inchangés.
  - Module isolé, testable unitairement, réversible (désactivable
    par config).
  - Le chemin `dryRun: false` est déjà exercé par les tests
    d'intégration existants (mock de contrat), donc le
    gestionnaire sera testé en conditions réelles simulées.

- Négatives :
  - Deux chemins de code (dry-run sans nonce, réel avec nonce)
    à maintenir.
  - La politique de bump borné doit être calibrée sur des
    receipts réels (dette à tracer).
  - Le gestionnaire ne s'exécute pas en CI (dry-run), donc sa
    couverture de test repose sur les mocks du chemin
    `dryRun: false`.

- Neutres :
  - Aucune modification de la machine à états existante : le
    journal SIGNED/SUBMITTED/CONFIRMED/REVERTED/UNKNOWN reste
    tel quel, seul le champ `nonce` est renseigné en amont.

## Conditions de réexamen

1. Passage en DRY_RUN=false sur le long terme → le
   gestionnaire devient la norme, l'option A redevient
   pertinente.
2. Découverte d'un bug de nonce en production réelle →
   réouverture immédiate.
3. Publication d'un nouveau mécanisme ethers v6 pour le nonce
   → réévaluation.

## Références

- bot/execute.js (catch de startArbitrage, reconcilePendingExecutions, lateReceipt)
- bot/executor.js (txInFlight, txInFlightMaxMs)
- bot/domain.js (ExecutionRecord.status)
- docs/PRIORITES.md (Suivi D0–D12, Suivi des dettes post-audit)
- AGENTS.md §10 (protocole de dégel du contrat)

---
