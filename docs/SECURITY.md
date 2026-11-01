# Sécurité — acceptations de risque

Ce fichier trace les acceptations de risque explicites, avec date
de réexamen et conditions de réouverture. Il ne remplace pas une
correction : une acceptation est une décision datée, pas un oubli.

## Point 7 — advisories Dependabot (revue du 2026-11-01)

### Contexte vérifié

- HEAD au moment de la revue : `24118468a5247609b0a3a30f8323f85cea36ee8c`
- Working tree : `?? audit-lot-1.txt` uniquement
- Versions résolues : `hardhat@2.29.1`, `@nomicfoundation/hardhat-toolbox@5.0.0`,
  `ethers@6.17.0`, `solc@0.8.20`, Node `v22.23.3`, npm `10.9.9`
- `npm audit --omit=dev --json` : `vulnerabilities: {}`
- `npm ls --omit=dev minimatch uuid elliptic cookie` : `(empty)`
- Aucun import direct de `minimatch`, `uuid`, `elliptic`, `cookie`
  dans `bot/`, `scripts/`, `test/`, `contracts/`, `hardhat.config.js`,
  `package.json`.

### Les 4 advisories (sous-ensemble Dependabot de `npm audit`)

| # | GHSA | CVE | Sévérité | Package | Scope | Plage | Patch | Résolu | isDirect |
|---|---|---|---|---|---|---|---|---|---|
| 1 | GHSA-g3hv-75wg-m249 | CVE-2026-118764 | moderate | minimatch | development | `< 11.0.1` | 11.0.1 | 9.0.9 / 5.1.9 / 3.1.5 | false |
| 2 | GHSA-w5hq-g745-h8pq | CVE-2026-41907 | moderate | uuid | development | `< 11.1.1` | 11.1.1 | 8.3.2 | false |
| 3 | GHSA-848j-6mx2-7j84 | CVE-2025-14505 | low | elliptic | development | `<= 6.6.1` | aucun | 6.6.1 | false |
| 4 | GHSA-pxg6-pf52-xh8x | CVE-2024-47764 | low | cookie | development | `< 0.7.0` | 0.7.0 | 0.4.2 | false |

### Classification (exploitabilité réelle, pas sévérité brute)

Toutes en **Catégorie C — non exploitable dans ce projet**.

- **minimatch (moderate).** DoS via motif glob crafté. Les motifs
  proviennent exclusivement de la configuration Hardhat/Mocha/coverage,
  jamais d'une entrée externe du bot. Le bot n'expose aucun endpoint
  qui alimente un glob. Atteint uniquement les runners CI
  (`npm ci` + `npx hardhat test/compile/run`).
- **uuid (moderate).** Bounds check manquant dans `v3/v5/v6` quand un
  buffer est fourni. Usage interne Hardhat (`hardhat@2.29.1 → uuid@8.3.2`),
  jamais appelé directement par le projet. Aucun buffer fourni par une
  entrée externe.
- **elliptic (low).** Primitive cryptographique à implémentation risquée
  (CWE-1240). Atteint uniquement via deux chaînes dev anciennes
  (`ethereumjs-util` et `eth-gas-reporter → ethers@5.8.0`). Le runtime
  du bot utilise `ethers@6.17.0`, qui n'utilise pas elliptic (il utilise
  `@noble/curves`). **Aucun patch publié** (`patched: null`).
- **cookie (low).** Parsing de cookie hors bornes. Atteint uniquement
  via `hardhat@2.29.1 → @sentry/node@5.30.0 → cookie@0.4.2`. Le bot
  n'a pas de serveur HTTP et n'expose aucun parsing de cookie
  contrôlable par un attaquant.

### Correctifs disponibles et pourquoi ils sont refusés

Les trois advisories avec patch (`minimatch`, `uuid`, `cookie`) ne
peuvent être corrigées que par un bump majeur `hardhat@2 → hardhat@3`
(et `@nomicfoundation/hardhat-toolbox@5 → @7`), qui casse la toolchain
(modèle de plugins, config, tâches). `elliptic` n'a aucun patch publié.
Aucun `npm audit fix`, `npm install`, `npm update` ou `npm ci` n'a été
exécuté.

### Décision

Accepter les 4 advisories telles quelles, sans modification de
`package.json` ni `package-lock.json`.

### Date de réexamen

**2027-02-01** (3 mois), ou immédiatement si l'une des conditions
suivantes survient :

1. Passage à Hardhat 3 (résoudra minimatch, uuid, cookie en même temps).
2. Ajout d'un serveur HTTP ou d'un parsing de cookie exposé (rouvre cookie).
3. Ajout d'une dépendance runtime utilisant `elliptic` (rouvre elliptic).
4. Publication d'un patch `elliptic` (rouvre elliptic).
5. `npm audit --omit=dev` cesse d'être vide (signale une régression
   vers l'arbre de production).

### Hors périmètre de cette acceptation

`npm audit` complet signale 46 nœuds affectés (20 low, 26 moderate,
0 high, 0 critical). Les 4 ci-dessus sont le sous-ensemble Dependabot.
Les 42 autres n'ont pas été triés individuellement dans ce point et
restent hors périmètre. Aucune décision les concernant n'est prise ici.
