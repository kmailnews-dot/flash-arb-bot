# ADR 0006 — Filtre dynamique de viabilité des paires (P1-16-bis)

- **Statut** : accepté (conception) — intégration implémentée, non commitée
- **Date** : 2026-11-20
- **Contexte** : P1-16-bis (écart médian dynamique), complément de P1-16
  (plafond statique de frais par jambe).
- **Portée** : spécification et décision. L'intégration est décrite en fin de
  document ; elle ne modifie aucune décision, aucune ABI ni aucun contrat.

> **Note de statut.** `docs/PRIORITES.md` reflète désormais P1-16-bis comme
> « FERMÉ » (intégration et tests ciblés validés, sans commit). Les décisions
> D1–D15 restent la référence de conception ; la section « Intégration dans
> le bot » documente les noms de variables et le comportement réellement
> branchés dans `bot/index.js` et `bot/config.js`.

## Contexte

`scanPair` (`bot/scanner.js:257-377`) parcourt toutes les tailles configurées
de toutes les paires à chaque cycle, en quotant tant que la profondeur le
permet, sans mémoire des cycles précédents.
`scan.yml` s'exécute toutes les 5 minutes dans un processus neuf
(`bot/ARCHITECTURE.md:9-33`) : un filtre en mémoire serait donc remis à zéro
à chaque exécution. Le journal `scans.jsonl` contient bien `netProfitBps`
(`bot/persist.js:78`), mais il ne stocke que le label de paire et le
symbole du token emprunté (`bot/persist.js:60-62`), pas la route complète
(routeurs, types de jambes, `v3Fee`, quoter). Il ne permet donc pas de
reconstruire un historique fiable par route après un changement de
configuration.

P1-16 (`bot/config.js:268-283`, commit `7f1af08`) applique un plafond
statique au chargement : `premium Aave + feeA + feeB <= maxTotalFeeBps`.
Ce contrôle est nécessaire mais ne voit pas l'économie réalisée. Une paire
peut passer ce plafond et ne jamais franchir `pair.minProfitBps` à cause de
la profondeur de pool, de l'impact de prix, du régime de gaz ou simplement
de l'absence d'écart. Le rapport G1 (`docs/PRIORITES.md:236-268`) a mesuré
des écarts structurellement négatifs sur les paires testées. Re-scanner ces
paires à chaque cycle consomme du quota RPC, ajoute de la latence et du
bruit, et retarde les paires qui pourraient produire une opportunité.

### Les quatre couches de filtrage

| Couche | Fichier | Moment | Décision | Politique d'échec |
|---|---|---|---|---|
| P1-16 — plafond statique de frais | `bot/config.js` (`validatePairs`) | chargement de la configuration | rejette une paire dont `premium + feeA + feeB > maxTotalFeeBps` | fail-closed (configuration invalide) |
| P1-16-bis — filtre dynamique (cet ADR) | nouveau module, branché dans `bot/index.js` | avant le scan de chaque paire | saute le scan d'une paire structurellement non viable | fail-open |
| `decide()` | `bot/decide.js` | avant chaque exécution | refuse une opportunité sous les planchers | fail-closed |
| guards + contrat | `bot/guards.js`, `bot/execute.js`, `FlashArbExecutor.sol` | envoi et exécution on-chain | bloquent l'envoi | fail-closed |

Cette séparation est volontaire : le filtre dynamique est la seule couche
fail-open, parce qu'elle ne protège pas le capital. La section D12 le
formalise.

## Problème

1. Une paire peut être valide statiquement (frais sous le plafond P1-16)
   mais structurellement non rentable dans la durée.
2. Le bot n'a aucun mécanisme inter-cycles pour déprioriser une telle
   paire : chaque exécution de `scan.yml` repart de zéro.
3. Un filtre naïf est soit trop réactif (dernier échantillon), soit
   sensible aux outliers (moyenne, EWMA), soit impossible à rendre exact
   avec des `number` JavaScript.
4. Le mécanisme doit rester borné, auditable, réversible, et ne jamais
   interférer avec les guards de protection du capital ni avec `decide()`.

## Options

### Option A — Statu quo, P1-16 seul

Conserver uniquement le plafond statique de frais. Simple, zéro nouveau
fichier d'état, zéro risque de régression. Mais aucune adaptation à
l'économie observée : une paire dont les frais sont sous le plafond mais
dont l'écart réalisé est négatif continue d'être scannée indéfiniment.

### Option B — Filtre sur le dernier échantillon

Rejeter une paire si son dernier `netProfitBps` est inférieur au plancher.
Réactif et simple, mais très bruité : une seule quote défavorable suffit à
filtrer, une seule quote favorable suffit à réactiver. Aucune hystérésis,
aucune robustesse aux outliers.

### Option C — Moyenne glissante ou EWMA

Calculer une moyenne (simple ou exponentielle) des `netProfitBps`. Une
seule valeur anormalement élevée peut masquer une paire structurellement
négative. Le calcul en virgule flottante perd l'exactitude des `bigint`
utilisés partout dans le scanner, et rend les tests de seuil fragiles.

### Option D — Médiane persistée sur fenêtre bornée, avec confirmation du dernier échantillon (retenue)

Persister les meilleurs `netProfitBps` par paire et par cycle dans un état
dédié, calculer une médiane exacte en `BigInt` sur une fenêtre bornée, et
n'exiger le rejet que si la médiane **et** le dernier échantillon sont
strictement sous le plancher. La médiane est robuste aux outliers ; la
confirmation du dernier échantillon apporte l'hystérésis nécessaire à la
récupération. L'état persistant est indispensable au mode cron ; il est
borné, versionné et reconstructible.

## Décision

Option D. Les sous-sections ci-dessous fixent les modalités. Les 18
décisions du point P1-16-bis sont récapitulées en fin de document.

### D1 — Source et état dédié

Le filtre lit et écrit un fichier d'état dédié :

    logs/pair_spreads.json

Le chemin par défaut est ancré sur le module, comme les autres états
(`bot/guards.js:9-13`, `bot/persist.js:5-6`, `bot/adaptive.js:13-14`) :

    path.resolve(__dirname, "..", "logs", "pair_spreads.json")

Variables proposées : `PAIR_SPREADS_PATH` pour l'override opérateur et
l'isolation des tests. Les tests devront passer un chemin temporaire
explicite et ne jamais lire ni écrire le `logs/` réel (même exigence que
la dette D13 de `docs/PRIORITES.md` pour les breaker windows). Ce nom
historique a été remplacé par `PAIR_SPREAD_PATH` lors de l'intégration
(voir « Intégration dans le bot »).

L'état est **dérivé**, pas un registre comptable :

- il ne contient que des adresses publiques et des `netProfitBps` ;
- il est reconstructible à partir des cycles futurs ;
- le supprimer est toujours sûr (l'historique repart de zéro) ;
- il n'est jamais versionné (`logs/` est ignoré par `.gitignore`) ;
- il n'est jamais complété depuis `scans.jsonl` : le journal ne contient
  pas la clé de route stable, et un backfill mélangerait des configurations
  différentes. L'historique commence à l'activation du filtre.

Schéma versionné (exemple avec clé tronquée) :

```json
{
  "version": 1,
  "pairs": {
    "v1|42161|0xaf88...|0x82af...|V3|0xe592...|500|0xb273...|V2|0x1b02...||": {
      "samples": [
        { "netProfitBps": "-42", "at": 1763500000000 },
        { "netProfitBps": "-37", "at": 1763500300000 }
      ]
    }
  }
}
```

Règles de forme :

- `version` vaut `1` ;
- `pairs` est un objet (pas un tableau) indexé par la clé stable de D7 ;
- chaque entrée contient un tableau `samples` ;
- chaque échantillon contient `netProfitBps` (chaîne décimale signée,
  parseable en `BigInt`) et `at` (entier sûr, epoch ms, positif ou nul) ;
- les champs inconnus sont ignorés ;
- un tableau `samples` plus long que la fenêtre est toléré en lecture : seuls
  les derniers par `at` sont conservés, et l'écriture tronque ;
- les entrées dont tous les échantillons sont expirés sont supprimées à
  l'écriture ;
- toute autre violation structurelle rend le fichier **corrompu** au sens
  de D6 (fail-open, aucune écriture).

Bornes : au plus `windowSize` échantillons par paire, et les paires dont le
dernier échantillon dépasse l'ancienneté maximale sont élaguées à la
prochaine écriture. La taille du fichier reste donc proportionnelle aux
paires actives et à la fenêtre, pas au nombre de cycles historiques.

### D2 — Échantillon retenu

Pour chaque paire, après `scanPair`, l'échantillon du cycle est le
**meilleur `netProfitBps` valide** parmi tous les résultats retournés :

- résultat sans `error` (donc ni `DEPTH_EXCEEDED`, ni `QUOTE_STALE`, ni
  erreur RPC) ;
- `netProfitBps` non `null` et de type `bigint` (un `0n` réellement mesuré
  est valide) ;
- `amountIn > 0n` (défensif ; la configuration interdit déjà les tailles
  nulles).

Règle :

    valides = results.filter((r) => !r.error && typeof r.netProfitBps === "bigint" && r.amountIn > 0n)
    echantillon = valides.length > 0 ? max(valides.map((r) => r.netProfitBps)) : null

Si aucun résultat valide, **aucun échantillon n'est enregistré** pour cette
paire ce cycle-là. Il ne faut jamais enregistrer `null`, une valeur de
remplacement, ni un `0` fabriqué pour combler une absence : cela fausserait
la médiane et pourrait filtrer une paire sur une donnée inventée. Un `0n`
réellement mesuré reste un échantillon valide.

Points d'implémentation importants :

- Ne pas réutiliser `selectBestResult` (`bot/index.js:63-66`) : il classe
  par `netProfitUsd` puis `grossProfit`, pas par `netProfitBps`.
- Ne pas prendre `results[0]` : `scanPair` trie par `grossProfit`
  (`bot/scanner.js:328-332`), et le résultat interpolé peut remplacer le
  premier élément (`bot/scanner.js:347-373`).
- Le maximum doit être calculé sur **tous** les résultats, y compris la
  taille interpolée re-quotée si elle est valide.
- `at` est l'horodatage d'observation du cycle (un seul `now` par cycle),
  pas le `quoteTimestamp` de chaque quote. Toutes les quotes d'un cycle
  partagent le même `blockTag` ; l'horodatage de cycle est la bonne unité
  de fenêtre.

Justification : `netProfitBps` est déjà normalisé par `amountIn`, donc les
tailles sont comparables. Le meilleur bps répond à la question « existe-t-il
une taille à laquelle cette paire franchit son plancher ? ». Si même le
meilleur ne le franchit pas, la paire est structurellement non viable. La
médiane sur plusieurs cycles lisse les quotes individuelles.

Nuance assumée : prendre le maximum de plusieurs tailles est un estimateur
légèrement biaisé vers le haut (winner's curse). Ce biais pousse le filtre
à **moins** rejeter, pas à rejeter à tort. C'est cohérent avec la politique
fail-open et le statut d'optimisation de D12.

### D3 — Fenêtre, activation et ancienneté

| Paramètre | Valeur | Règle |
|---|---|---|
| Fenêtre | 20 échantillons par paire | seuls les 20 plus récents par `at` sont conservés et évalués |
| Activation | 5 échantillons valides | en dessous, le filtre est inactif pour la paire (fail-open) |
| Ancienneté maximale | 24 h par défaut (provisoire), limite configurable 168 h | un échantillon avec `at < now - maxAgeMs` est ignoré ; la borne est inclusive (`at >= now - maxAgeMs` est valide) |

`now` est figé une fois par cycle. La fenêtre est glissante en nombre
d'échantillons, pas en temps : si les cycles sont plus espacés que 5
minutes, 20 échantillons peuvent couvrir plus de 100 minutes. L'ancienneté
maximale borne la période réellement prise en compte.

`PAIR_SPREAD_MAX_AGE_MS` vaut `86400000` (24 h) par défaut. La validation
accepte toute valeur finie dans `(0, 604800000]`, soit jusqu'à 168 h
(7 jours) : 24 h est la valeur par défaut, pas un plafond absolu. Les
paragraphes suivants décrivent le comportement pour la valeur configurée
`maxAgeMs`, quelle qu'elle soit.

Un échantillon daté dans le futur (`at > now`) est ignoré pour l'évaluation
et peut être élagué à l'écriture : il ne doit ni maintenir une paire
filtrée, ni la réactiver artificiellement.

L'ancienneté maximale a un second rôle important : elle borne la durée
maximale d'un rejet en mode `enforce`. Une paire filtrée ne produit plus de
nouvel échantillon ; au bout de `maxAgeMs`, tous ses échantillons sont
expirés, le filtre retombe en « insuffisant » (fail-open), la paire est
rescannée et l'historique repart. Le blackout maximal est donc d'environ
`maxAgeMs` après le dernier échantillon, soit 24 h avec la valeur par
défaut et jusqu'à 7 jours si l'opérateur relève la borne, sans intervention
manuelle. Ce point est détaillé en D5 et dans les limites.

Les valeurs 20, 5 et 24 h (ancienneté par défaut) sont **provisoires** ; la
section « Valeurs provisoires à recalibrer » précise les critères
d'ajustement. La limite de validation à 168 h n'est pas une valeur
provisoire de calibration : c'est la borne haute acceptée par la
configuration.

### D4 — Modes

| Mode | Lit l'état | Évalue | Scanne | Écrit | Effet |
|---|---|---|---|---|---|
| `off` | non | non | toujours | non | aucun ; comportement strictement identique à l'existant |
| `shadow` | oui | oui | **toujours** | oui | journalise la décision qui aurait été prise ; ne saute aucune paire |
| `enforce` | oui | oui | sauf rejet | oui | saute le scan des paires rejetées |

- Mode par défaut : `off`.
- Variable proposée : `PAIR_SPREAD_FILTER_MODE`.
- Valeurs acceptées : `off`, `shadow`, `enforce` (comparaison insensible à
  la casse, comme `DRY_RUN`).
- Une valeur inconnue est une **erreur de configuration** au chargement,
  pas une panne d'état : le démarrage est refusé comme pour les autres
  validations de `bot/config.js`. Cela évite qu'une faute de frappe active
  silencieusement `enforce`.
- En `off`, le filtre ne fait aucun I/O : il ne crée pas `pair_spreads.json`
  et ne lit pas un fichier existant. C'est le mode de déploiement par
  défaut, y compris en CI et en `DRY_RUN=true`.
- En `shadow`, le scan continue **toujours** (décision 16), même si la
  règle de D5 conclut au rejet. Le mode sert à mesurer les faux positifs et
  les faux négatifs avant `enforce`.
- En `enforce`, le rejet est décidé **avant** toute quote de la paire. Une
  paire rejetée ne produit ni appel RPC, ni entrée `scans.jsonl`.
- Le mode est indépendant de `DRY_RUN` : le filtre fonctionne à l'identique
  en dry-run et en réel. Il ne modifie jamais `DRY_RUN`.

Le passage `off → shadow → enforce` est un déploiement en trois étapes. Le
mode `enforce` ne doit pas être activé avant une phase `shadow` couvrant au
moins une fenêtre complète et une durée supérieure à l'ancienneté maximale
(voir le plan de calibration).

### D5 — Comparaison, règle de rejet et récupération

Le plancher de comparaison est **`pair.minProfitBps`**, converti en
`BigInt`. Ce n'est pas :

- `config.effectiveMinProfitBps` (plancher adaptatif du cycle) ;
- `config.minProfitBps` (plancher global) ;
- la valeur retournée par `effectiveMinProfitBps({ pair, config })`
  (`bot/pricing.js:144-148`), qui vaut
  `max(pair.minProfitBps, config.effectiveMinProfitBps)`.

Justification : `pair.minProfitBps` est immuable et borné par profil
(`bot/config.js:35-39`, `172-186`). Le plancher adaptatif peut monter après
des échecs. Comparer la médiane au plancher adaptatif créerait une boucle
de rétroaction : l'adaptive monte → le filtre rejette → moins d'exécutions
→ l'adaptive réagit sur un historique appauvri. Le filtre doit mesurer la
viabilité structurelle contre le plancher propre et immuable de la paire.
Si le plancher adaptatif est plus élevé, `decide()` continue de l'appliquer
à chaque opportunité ; le filtre n'a pas à le dupliquer.

Si `pair.minProfitBps` est absent ou invalide à l'exécution (ne devrait pas
arriver après `validatePairs`, mais possible avec une configuration injectée
en test), le filtre est fail-open pour cette paire et émet un warning. Il
ne faut pas retomber silencieusement sur `0`.

Soit les échantillons valides. `last` est celui de plus grand `at`. Pour la
médiane, on trie une copie par valeur croissante. Soit `n` leur nombre et
`floor = BigInt(pair.minProfitBps)`.

Médiane exacte :

- `n` impair : `doubledMedian = 2n * s[(n - 1) / 2]` ;
- `n` pair : `doubledMedian = s[n / 2 - 1] + s[n / 2]`.

Comparaison sur la médiane doublée, sans division :

    medianBelow = doubledMedian < 2n * floor

Rejet :

    reject = n >= minSamples
          && medianBelow
          && last < floor

`last` est l'échantillon valide le plus récent (plus grand `at`) après
filtrage par ancienneté. Les deux conditions sont **strictes** : une
médiane ou un dernier échantillon exactement égal au plancher autorise le
scan.

Table de vérité :

| Médiane < plancher | Dernier < plancher | Décision |
|---|---|---|
| non | non | scan |
| non | oui | scan (pas de confirmation) |
| oui | non | scan (récupération) |
| oui | oui | rejet en `enforce`, would-reject en `shadow` |

Exemples avec `floor = 30` :

- `[-80, -60, -40, -20, -10]` : médiane `-40`, doublée `-80 < 60`, dernier
  `-10 < 30` → rejet.
- `[-80, -60, -40, -20, 35]` : médiane `-40` sous le plancher, mais dernier
  `35 >= 30` → scan (récupération).
- `[-80, -60, 30, 40, 50]` : médiane `30`, doublée `60`, pas strictement
  inférieure à `60` → scan (égalité).
- `[-80, -60, -40, -20]` : `n = 4`, doublée `-100 < 60`, dernier `-20 < 30`
  → rejet.
- `[20, 40]` : doublée `60`, pas strictement inférieure à `60` → scan
  (médiane exactement 30).

Récupération :

- **Voie rapide** : un échantillon récent (`at` dans la fenêtre d'ancienneté)
  supérieur ou égal au plancher, s'il est le dernier, fait échouer la
  seconde condition et autorise immédiatement un nouveau scan. C'est la
  décision 9.
- **Voie lente** : si aucun échantillon récent ne subsiste (tous expirés),
  le nombre d'échantillons valides tombe sous `minSamples`, le filtre est
  fail-open, la paire est rescannée, et un nouvel échantillon est écrit.
  C'est le filet de sécurité borné par l'ancienneté maximale.

Aucune marge n'est appliquée en v1 : le rejet se fait exactement sous le
plancher. Si la phase `shadow` montre des rejets trop agressifs, une marge
`median < floor - marge` pourra être ajoutée ; ce serait une révision de
cet ADR, pas une interprétation.

### D6 — État absent, insuffisant, corrompu ou illisible

Politique unique : **fail-open**, scan autorisé, warning. Le filtre est une
optimisation ; une panne de son état ne doit jamais bloquer un scan.

| Situation | Détection | Décision | Écriture | Journal |
|---|---|---|---|---|
| Fichier absent | `ENOENT` | scan | création à la première écriture | warning de cycle |
| Moins de 5 échantillons valides | comptage après ancienneté | scan | oui, si de nouveaux échantillons existent | warning de cycle |
| JSON invalide ou fichier vide | `SyntaxError` | scan | **non** | warning avec chemin |
| Version inconnue | `version !== 1` | scan | **non** | warning avec chemin |
| Schéma invalide | validation D1 | scan | **non** | warning avec chemin |
| Erreur d'E/S | `EACCES`, `EISDIR`, autre | scan | **non** | warning avec chemin |
| Écriture échouée | erreur au `rename`/`write` | le scan a déjà eu lieu | — | warning |

Règles :

- **Ne jamais écraser un état corrompu ou illisible.** Si le fichier est
  corrompu, illisible, ou d'une version inconnue, aucune écriture n'est
  faite pendant le cycle, même si d'autres paires ont produit des
  échantillons valides. Ces échantillons sont perdus pour ce cycle. C'est
  un compromis assumé : préserver la preuve et éviter de réinitialiser
  silencieusement un historique. L'opérateur doit inspecter puis corriger
  ou supprimer le fichier ; le supprimer est sûr (état reconstructible).
- Un fichier **absent** n'est pas corrompu : il est créé à la première
  écriture. Un fichier **vide** est un JSON invalide, donc corrompu,
  comme dans M1-bis.
- Les codes de journalisation proposés sont préfixés pour éviter toute
  confusion avec les guards fail-closed :
  `PAIR_SPREAD_STATE_CORRUPT`, `PAIR_SPREAD_STATE_SCHEMA_INVALID`,
  `PAIR_SPREAD_STATE_UNREADABLE`. Ils ne doivent **jamais** être propagés à
  `runGuard` ni à `checkCircuitBreaker` ; ce sont des warnings du filtre.
- Un seul warning par cycle et par fichier, pas un par paire, pour éviter
  le spam. Le warning inclut le chemin et la raison.
- Ces situations ne modifient pas l'`exitCode` : ce ne sont pas des erreurs
  de scan ou de RPC.

### D7 — Clé stable

La clé identifie la route on-chain, pas la présentation de la paire. Elle
est une chaîne canonique à champs fixes, dans cet ordre :

    v1 | chainId | borrowedToken | intermediateToken
       | legOut.kind | legOut.router | legOut.v3Fee | legOut.quoter
       | legBack.kind | legBack.router | legBack.v3Fee | legBack.quoter

Champs :

- `v1` : préfixe de version du schéma de clé ;
- `chainId` : chainId réel vérifié du cycle (pas `EXPECTED_CHAIN_ID`) ;
- `borrowedToken`, `intermediateToken` : adresses en minuscules ;
- `legOut.kind`, `legBack.kind` : `V2` ou `V3` ;
- `legOut.router`, `legBack.router` : adresses en minuscules ;
- `legOut.v3Fee`, `legBack.v3Fee` : entier, ou chaîne vide pour une jambe V2 ;
- `legOut.quoter`, `legBack.quoter` : adresse en minuscules, ou chaîne vide
  pour une jambe V2.

Toutes les adresses sont normalisées en minuscules (`.toLowerCase()`),
jamais en checksum `ethers.getAddress` : deux écritures de la même adresse
avec une casse différente doivent produire la même clé.

Exemple (tronqué) :

    v1|42161|0xaf88...|0x82af...|V3|0xe592...|500|0xb273...|V2|0x1b02...||

Champs volontairement **exclus** :

- `label` et `profile` : présentation et regroupement adaptatif, pas la
  route on-chain ;
- `tradeSizes` et `logSweep` : `applyAdaptive` les met à l'échelle à chaque
  cycle (`bot/adaptive.js:222-251`). Les inclure ferait changer la clé à
  chaque variation du facteur de taille et détruirait l'historique ;
- `feeBps` et `maxTotalFeeBps` : entrées de validation P1-16 ; ils ne
  changent pas la route de quote. Les frais réels sont ceux de la pool ;
- `minProfitBps` : paramètre de comparaison, pas de route. Si l'opérateur
  change le plancher, les mêmes observations sont réévaluées contre le
  nouveau plancher ; c'est le comportement souhaité ;
- `legOut.tokenOut` et `legBack.tokenOut` : redondants, `validatePairs`
  impose déjà leur égalité avec `intermediateToken` et `borrowedToken`
  (`bot/config.js:261-266`) ;
- `decimals`, `symbol`, `isStable`, `isWeth` : métadonnées ; l'identité est
  l'adresse, et les symboles peuvent changer.

Conséquences :

- Un changement de `v3Fee`, de quoter ou de routeur crée une nouvelle clé :
  c'est une nouvelle route, l'ancien historique n'est pas réutilisable.
  L'ancienne entrée expire après l'ancienneté maximale.
- Un changement de `minProfitBps` ou de `profile` conserve la clé : les
  observations restent valides, seul le seuil de comparaison change.
- La clé est lisible et auditable ; elle n'est pas hachée. Sa longueur est
  bornée par la longueur des adresses. Si elle devenait un problème, un
  hash pourrait être ajouté dans une clé `v2`.
- Pour V2, le couple routeur + tokens est supposé identifier la pool. Un
  routeur V2 multi-factory nécessiterait un champ supplémentaire ; ce n'est
  pas le cas des routeurs configurés aujourd'hui.

### D8 — Déduplication

- Un seul échantillon par clé stable et par cycle.
- À l'intérieur d'une paire, le maximum de D2 couvre toutes les tailles et
  l'éventuel résultat interpolé.
- Si deux entrées de configuration partagent la même clé (doublon de
  route), un seul échantillon est conservé : le meilleur des deux scans.
  Si les doublons ont des `minProfitBps` différents, le même historique est
  évalué contre deux planchers dans le même cycle ; c'est un défaut de
  configuration à corriger séparément. Le filtre ne l'amplifie pas.
- Une paire filtrée en `enforce` ne produit aucun échantillon (aucun scan).
- Une paire en `shadow` produit toujours son échantillon, même si la
  décision simulée est un rejet.

Sans cette déduplication, une paire avec 10 tailles remplirait la fenêtre
10 fois plus vite qu'une paire avec une seule taille, et la fenêtre ne
mesurerait plus des cycles mais des quotes.

### D9 — Médiane exacte en BigInt

- Les valeurs sont stockées en chaînes décimales et parsées avec `BigInt`.
  Toute chaîne ne correspondant pas à `^-?\d+$` rend le fichier corrompu
  (D6).
- Le tri utilise un comparateur explicite :
  `(a, b) => (a < b ? -1 : a > b ? 1 : 0)`. Ne jamais utiliser le tri par
  défaut de `Array.prototype.sort` sur des chaînes : l'ordre serait
  lexicographique (`"-10"` avant `"-2"`), pas numérique.
- Aucun `Number`, `parseFloat`, `Math.round` ou `toFixed` n'intervient dans
  la médiane ou la comparaison.
- La comparaison se fait sur la médiane doublée (D5), ce qui évite toute
  division et tout arrondi, y compris pour un nombre pair d'échantillons et
  des valeurs négatives.
- Le dernier échantillon est comparé directement en `BigInt` :
  `last < floor`.

### D10 — Aucun double comptage

`netProfitBps` est déjà net de tous les coûts. Le filtre le consomme
**tel quel** et ne soustrait rien.

| Composant | Où il est déjà compté | Référence |
|---|---|---|
| Premium Aave | `premium = amountIn * premiumBps / 10000`, puis `owed = amountIn + premium` | `bot/scanner.js:136-139` |
| Frais de pool | intégrés dans `intermediateOut` et `finalOut` par les quotes | `bot/scanner.js:119-134` |
| Gaz L2 | `gasCostInToken = gasCostInBorrowedToken(gasCostWei, ...)` | `bot/scanner.js:141-155` |
| Multiplicateur L1 | appliqué dans `gasCostInBorrowedToken` via `l1MultiplierBps` | `bot/pricing.js:11-20` |
| Profit net | `netProfit = grossProfit - gasCostInToken` | `bot/scanner.js:155` |
| BPS net | `netProfitBps = netProfit * 10000 / amountIn` | `bot/scanner.js:156-157` |

Interdictions explicites :

- ne pas utiliser `grossProfit` ou `grossProfitUsd` pour le filtre : ce sont
  des montants bruts, et l'USD n'est pas la même unité que le plancher bps ;
- ne pas utiliser `netProfitUsd` : le plancher de comparaison est en bps ;
- ne pas re-soustraire le premium, les frais de pool, le gaz ou le L1 ;
- ne pas appliquer `l1CostMultiplierBps` une seconde fois.

Si une évolution future change la sémantique de `netProfitBps` (par exemple
en excluant le gaz), cet ADR doit être rouvert. Un test d'implémentation
devra utiliser une fixture où un double comptage du premium ferait basculer
la décision, pour verrouiller cette propriété.

### D11 — Complémentarité avec P1-16 et `decide()`

| Mécanisme | Portée | Moment | Rôle |
|---|---|---|---|
| P1-16 | configuration d'une route | chargement | plafond statique `premium + feeA + feeB` |
| P1-16-bis | paire, sur historique observé | avant le scan | évite de scanner une paire structurellement non viable |
| `decide()` | opportunité, sur quote fraîche | avant l'envoi | refuse une exécution sous les planchers |
| Contrat | transaction | on-chain | applique `minProfit` et `minProfitBps` |

Règles :

- P1-16 reste nécessaire : il rejette une mauvaise configuration avant le
  premier appel RPC. P1-16-bis ne le remplace pas et ne modifie pas
  `validatePairs`, `feeBps` ou `maxTotalFeeBps`.
- P1-16-bis est complémentaire : il apprend l'économie réalisée, que P1-16
  ne peut pas voir.
- Le filtre ne remplace **jamais** `decide()`. Il ne l'appelle pas, ne
  modifie pas ses entrées, et ne change ni `minProfitBps`, ni `minProfit`,
  ni `minAmountOut`, ni `slippageBps`, ni `gasLimit`, ni `feeOverrides`.
- Le filtre peut seulement **réduire l'ensemble des paires scannées**. Il
  ne peut pas créer une opportunité que `scanPair` n'aurait pas produite,
  ni autoriser une exécution que `decide()` refuserait.
- En `shadow`, l'ensemble des paires scannées est inchangé : l'effet sur
  `decide()` est nul par construction.
- En `enforce`, une paire sautée ne produit aucune opportunité. C'est le
  seul effet : une opportunité manquée, jamais une perte de capital.

### D12 — Sécurité : optimisation, pas guard de capital

> **P1-16-bis est un mécanisme d'optimisation, pas un guard de protection
> du capital.**

Cette nature justifie sa politique **fail-open**, qui est volontaire et
distincte des protections **fail-closed** de M1-bis.

Pourquoi fail-open :

- un faux négatif (filtre trop agressif) coûte une opportunité ;
- un faux positif (filtre trop permissif) coûte du quota RPC et de la
  latence ;
- aucune des deux ne coûte du capital ;
- bloquer le bot parce qu'un fichier d'optimisation est illisible serait
  une panne de disponibilité auto-infligée, sans bénéfice de sécurité.

Ce que M1-bis protège, et que P1-16-bis ne doit jamais contourner :

- `checkCircuitBreaker` et ses sous-contrôles (consecutive failures, revert
  rate, unknown rate, gas drawdown, RPC error rate, gas anomaly) ;
- `checkDailyGas`, la balance wallet, le chainId, le `staticCall`, la
  réservation de gaz, le breaker final avant envoi ;
- `decide()` et les exigences on-chain `minProfit` / `minProfitBps`.

Règles d'isolation :

- ne jamais brancher le filtre dans `runGuard` ;
- ne jamais laisser une erreur de `pair_spreads.json` ouvrir ou fermer le
  circuit breaker ;
- ne jamais faire suivre aux codes du filtre le chemin fail-closed des
  codes `STATE_FILE_CORRUPT` / `STATE_FILE_UNREADABLE` : les codes du
  filtre sont préfixés `PAIR_SPREAD_` et restent des warnings ;
- ne jamais utiliser l'état du filtre pour modifier le nonce, le gaz, la
  slippage, `minProfit` ou `minAmountOut` ;
- ne jamais écrire dans `gas_spent.json`, `circuit_breaker.json`,
  `rpc_errors.json`, `gas_history.json`, `adaptive.json` ou
  `executions.json`.

Pires cas :

| Situation | Conséquence | Risque capital |
|---|---|---|
| État absent ou insuffisant | paires mortes scannées | aucun (quotes en lecture seule) |
| État corrompu ou illisible | toutes les paires scannées + warning | aucun |
| Faux rejet en `enforce` | paire viable non scannée | opportunité manquée, pas de perte |
| Faux accept | paire morte scannée | RPC gaspillé, pas de perte |
| Écriture échouée | historique non mis à jour | aucun |

L'état ne contient aucun secret : uniquement des adresses publiques, des
`netProfitBps` et des horodatages. Il est local et ignoré par Git
(`logs/`). Un attaquant capable d'écrire dans `logs/` pourrait influencer
la couverture de scan, mais ne pourrait pas autoriser une exécution : les
guards et `decide()` restent les seules autorités. La compromission locale
de `logs/` est un risque plus large, déjà hors périmètre des guards
existants.

### D13 — Scan, exit code et observabilité

Déroulé d'un cycle en `shadow` ou `enforce` :

1. Lire l'état une fois, avec un `now` unique.
2. Pour chaque paire configurée, calculer la décision de D5.
3. En `shadow` : scanner toujours, journaliser la décision simulée
   (`wouldFilter`), puis enregistrer l'échantillon.
4. En `enforce` : si rejet, incrémenter `filteredPairs`, journaliser, et
   passer à la paire suivante **sans** `scanPair` ni entrée `scans.jsonl`.
   Sinon, scanner et enregistrer l'échantillon.
5. Après la boucle, écrire l'état une fois (D14).
6. Calculer l'`exitCode`.

Compteurs :

- `filteredPairs` : paires sautées par `enforce` uniquement ;
- `wouldFilterPairs` : paires qui auraient été sautées en `shadow` ; ne
  participe jamais à l'`exitCode` ;
- `scanned` : nombre de résultats de quote, comme aujourd'hui. Une paire
  filtrée n'incrémente pas `scanned` ;
- `opportunities` et `executed` : inchangés.

Règle d'`exitCode` :

    exitCode = 1 si rpcErrors > maxRpcErrorsPerScan
               ou si (scanned === 0 et au moins une paire n'a pas été
                      volontairement filtrée)
    sinon 0

Autrement dit : si **toutes** les paires configurées ont été filtrées par
`enforce`, et qu'aucune autre erreur n'est survenue (pas de dépassement
`maxRpcErrorsPerScan`, pas de refus chainId, pas d'exception non gérée),
l'`exitCode` est `0`. Le cycle est un succès volontaire : le bot a décidé
de ne rien scanner. Le comportement existant `scanned === 0 → 1`
(`bot/index.js:340`) est conservé pour tous les autres cas, notamment une
paire qui lève une exception avant de produire un résultat.

`recordRpcCycle` continue de recevoir `total = scanned` : une paire filtrée
n'est pas une tentative RPC. Si toutes les paires sont filtrées,
`total = 0`, et `checkRpcErrorRate` retourne un échantillon nul sans ouvrir
le breaker (comportement documenté `bot/guards.js`). `recordGasSample`
reste inchangé : le gaz observé est une donnée de cycle, indépendante du
scan des paires.

Observabilité :

- un warning de cycle si l'état est absent, insuffisant, corrompu ou
  illisible (D6), avec le chemin et la raison ;
- en `shadow`, un événement structuré par paire avec le label, la clé (ou
  une empreinte), la médiane doublée, le plancher, le dernier échantillon,
  le nombre d'échantillons et `wouldFilter` ;
- en `enforce`, le même événement pour les paires filtrées, avec la raison
  `PAIR_SPREAD_BELOW_FLOOR` ;
- un résumé de fin de cycle incluant `filtered` et, en `shadow`,
  `wouldFilter` ;
- aucun secret, aucune URL RPC, aucune clé privée dans ces logs.

Une paire filtrée n'écrit **pas** dans `scans.jsonl`, car aucune quote n'a
été produite. L'événement structuré est la trace d'audit du skip. Cela
évite de polluer les statistiques de scan et de faire croire à une quote
qui n'existe pas.

### D14 — Écriture atomique, une fois par cycle

- L'état est chargé une fois, modifié en mémoire, puis écrit **au plus une
  fois** par cycle, après la boucle des paires.
- Écriture atomique : `mkdir` du répertoire, fichier temporaire
  `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`, écriture JSON, `fh.sync()`, fermeture,
  puis `fs.rename`. Mêmes conventions que `bot/guards.js:78-89` et
  `bot/persist.js:140-151`.
- Aucune écriture en mode `off`.
- Aucune écriture si l'état est corrompu, illisible ou d'une version
  inconnue (D6).
- Aucune écriture si aucun échantillon n'a été ajouté et aucun échantillon
  expiré n'a été élagué : le cycle est un no-op pour l'état. C'est le cas,
  par exemple, d'un cycle où toutes les paires sont filtrées.
- Une erreur d'écriture est un warning, pas une erreur de cycle : le scan a
  déjà eu lieu, l'`exitCode` n'est pas modifié.
- Les échantillons sont triés par `at` avant écriture, et les entrées sans
  échantillon valide sont supprimées. Le JSON est indenté (2 espaces) avec
  un saut de ligne final, comme les autres états.
- Aucun verrou inter-process. `fs.rename` garantit qu'un lecteur ne voit
  jamais un JSON tronqué, mais deux cycles concurrents peuvent produire un
  « dernier écrivain gagne » et perdre les échantillons de l'autre. C'est
  acceptable pour un état d'optimisation : le prochain cycle réécrit, et
  l'ancienneté maximale borne la perte. Un verrou pourra être ajouté si le
  cron chevauche régulièrement les cycles.

### D15 — Configuration

Noms proposés, à aligner sur le style de `bot/config.js` lors de
l'implémentation. La colonne « Défaut » indique la valeur par défaut.

> **Noms historiques.** Les noms de cette section (ainsi que
> `PAIR_SPREAD_FILTER_MODE` en D4) sont les propositions initiales. Ils
> ont été remplacés par ceux de la section « Intégration dans le bot » ;
> en particulier, la variable effective du chemin d'état est
> `PAIR_SPREAD_PATH`, et non `PAIR_SPREADS_PATH`.

| Réglage | Variable | Défaut | Validation proposée |
|---|---|---|---|
| Mode | `PAIR_SPREAD_FILTER_MODE` | `off` | `off`, `shadow` ou `enforce` ; valeur inconnue = erreur de config |
| Chemin d'état | `PAIR_SPREADS_PATH` | `logs/pair_spreads.json` (absolu, ancré sur le module) | chaîne non vide ; chemin absolu recommandé |
| Fenêtre | `PAIR_SPREAD_WINDOW_SIZE` | `20` | entier entre 5 et 100 |
| Échantillons minimum | `PAIR_SPREAD_MIN_SAMPLES` | `5` | entier entre 5 et `windowSize` |
| Ancienneté maximale | `PAIR_SPREAD_MAX_AGE_HOURS` | `24` | nombre fini > 0 et ≤ 168 ; converti en ms en interne |

Les bornes sont volontairement conservatrices. `PAIR_SPREAD_MIN_SAMPLES`
ne peut pas descendre sous 5 : la décision d'activation statistique est
fixée à 5, et une calibration différente passerait par une révision de cet
ADR.

### Intégration dans le bot

L'implémentation a aligné les noms proposés en D15 sur le style de
`bot/config.js`. Les décisions D1–D14 sont inchangées ; seuls les noms de
variables et les points de branchement sont précisés ici.

| Réglage | Variable réellement lue | Défaut | Validation |
|---|---|---|---|
| Mode | `PAIR_SPREAD_MODE` | `off` | `off`, `shadow` ou `enforce` ; valeur inconnue = erreur explicite `PAIR_SPREAD_MODE is invalid` |
| Chemin d'état | `PAIR_SPREAD_PATH` | `logs/pair_spreads.json` (absolu, ancré sur `bot/pairSpreadStore.js`) | chaîne non vide ; chemin absolu recommandé |
| Fenêtre | `PAIR_SPREAD_WINDOW_SIZE` | `20` | entier entre 5 et 100 |
| Échantillons minimum | `PAIR_SPREAD_MIN_SAMPLES` | `5` | entier entre 5 et `PAIR_SPREAD_WINDOW_SIZE` |
| Ancienneté maximale | `PAIR_SPREAD_MAX_AGE_MS` | `86400000` (24 h) | nombre fini dans `(0, 604800000]` (168 h) |

Points de branchement :

- `bot/config.js` valide le mode et les bornes au chargement, expose
  `pairSpreadMode`, `pairSpreadPath`, `pairSpreadWindowSize`,
  `pairSpreadMinSamples`, `pairSpreadMaxAgeMs` et exporte
  `validatePairSpreadSettings` pour les tests.
- `bot/index.js` résout le mode avant tout appel RPC. En mode `off`, il ne
  charge ni ne crée `logs/pair_spreads.json` et ne lit aucun échantillon.
- En `shadow`/`enforce`, l'état est chargé **une seule fois** après la
  vérification du chainId, avec un `now` unique pour le cycle. Une erreur de
  chargement est un warning : le cycle continue avec un historique vide.
- La clé est `buildPairKey({ chainId, pair })`. La décision
  `decidePairSpread()` compare uniquement `pair.minProfitBps` (D11) ; une
  donnée absente, insuffisante ou invalide reste fail-open (D6).
- En `shadow`, la décision est journalisée (`wouldFilter`) et la paire est
  toujours scannée. En `enforce`, une décision `skip` incrémente
  `filteredPairs`, journalise `PAIR_SPREAD_BELOW_FLOOR` et passe à la paire
  suivante sans `scanPair` ni entrée `scans.jsonl`.
- Après un scan réussi, un seul échantillon par clé et par cycle est retenu :
  `bestNetProfitBps(results)` (D8, D10). Aucun échantillon pour `null`, une
  erreur, ou une paire filtrée.
- L'état est persisté au plus une fois après la boucle, via
  `recordPairSpreadSamples({ loaded })` (D14). Aucune écriture en mode `off`,
  si l'état n'est pas inscriptible, ou si rien n'a changé. Un état corrompu,
  illisible ou d'une version inconnue n'est jamais remplacé.
- L'`exitCode` suit D13 : `0` si `enforce` a filtré toutes les paires
  configurées sans erreur indépendante ; `1` sinon (aucune paire, zéro scan
  non volontaire, refus chainId, erreur de paire ou seuil RPC).
- Les logs réutilisent `logEvent`/`logFormat` : mode, disponibilité de
  l'état, décision par paire, raison du filtre, compteurs et résultat de
  persistance. Aucun secret ni URL RPC n'y figure.

## Valeurs provisoires à recalibrer

Les valeurs suivantes sont **provisoires**. Elles sont fixées pour rendre
la conception testable, pas parce qu'elles sont optimales.

| Paramètre | Valeur provisoire | Justification initiale | Signal de recalibrage |
|---|---|---|---|
| Fenêtre | 20 échantillons | aligné sur `GAS_ANOMALY_WINDOW_SIZE` (ADR 0005) ; ~100 min à 5 min/cycle | trop de faux rejets → augmenter ; réaction trop lente à un changement de régime → diminuer |
| Échantillons minimum | 5 | compromis bruit / couverture ; aligné sur `GAS_ANOMALY_MIN_SAMPLES` | faux rejets au démarrage → augmenter ; filtre inactif trop longtemps sur des paires actives → diminuer (révision d'ADR) |
| Ancienneté maximale | 24 h par défaut (limite configurable : 168 h) | couvre une journée d'exploitation et borne le blackout d'une paire filtrée ; la limite haute laisse la place à des cycles moins fréquents | cycles moins fréquents ou pauses week-end → augmenter, jusqu'à 168 h ; spread qui change vite → diminuer |
| Marge sous le plancher | 0 bps | comparaison stricte, pas de biais supplémentaire | faux rejets en `shadow` → introduire une marge positive (rejeter seulement sous `floor - marge`) |
| Confirmation du dernier échantillon | activée | hystérésis ; évite de filtrer sur une médiane périmée | rejets persistants alors que la paire se rétablit → réévaluer |
| Mode par défaut | `off` | aucun effet tant que non activé | ferme : ne pas changer sans décision explicite |
| Durée de `shadow` avant `enforce` | au moins une fenêtre complète et > ancienneté maximale configurée (24 h par défaut, jusqu'à 168 h) | doit couvrir le renouvellement des échantillons | à ajuster après les premières mesures |

Points qui devront être recalibrés après la phase `shadow` :

1. **Fenêtre et minimum d'échantillons** : vérifier que 20 et 5 ne
   produisent ni trop de rejets ni une inactivité prolongée.
2. **Ancienneté maximale** : vérifier que la valeur retenue (24 h par
   défaut, jusqu'à 168 h) correspond au rythme réel des cycles et au
   blackout acceptable pour une paire filtrée.
3. **Marge** : mesurer les faux négatifs (paires would-reject qui auraient
   produit une opportunité) et décider si une marge est nécessaire.
4. **Confirmation du dernier échantillon** : vérifier qu'elle accélère
   suffisamment la récupération sans réactiver trop souvent des paires
   mortes.
5. **Périmètre des paires** : vérifier que les paires dont `netProfitBps`
   est `null` (gaz non pricé) restent bien en fail-open permanent, et
   décider si elles doivent être exclues explicitement du filtre.
6. **Interaction avec l'adaptive** : vérifier que la comparaison à
   `pair.minProfitBps` ne crée pas de comportement inattendu lorsque
   `effectiveMinProfitBps` monte.

## Plan de calibration après `shadow`

1. Activer `PAIR_SPREAD_MODE=shadow` sur un environnement
   représentatif, en `DRY_RUN=true`.
2. Attendre au moins 20 échantillons par paire active et une durée
   supérieure à l'ancienneté maximale, pour couvrir un renouvellement
   complet.
3. Relever, par paire : nombre d'échantillons, médiane, dernier échantillon,
   plancher, nombre de cycles `wouldFilter`, et évolution dans le temps.
4. Identifier les **faux négatifs** : paires `wouldFilter` qui ont tout de
   même produit un `isOpportunity` pendant la période. En `shadow`, elles
   sont scannées, donc observables.
5. Identifier les **faux positifs** : paires jamais opportunes mais
   scannées à chaque cycle.
6. Ajuster fenêtre, minimum d'échantillons, ancienneté et marge selon les
   signaux du tableau ci-dessus.
7. Ne passer en `enforce` que si les faux négatifs sont nuls ou
   explicitement acceptés, et si le blackout maximal correspondant à
   l'ancienneté configurée (24 h par défaut, jusqu'à 168 h) est jugé
   acceptable.
8. Documenter les résultats et les valeurs retenues dans une mise à jour
   ultérieure de `docs/PRIORITES.md` et `bot/ARCHITECTURE.md` (hors de ce
   document).

## Conséquences

### Positives

- Moins d'appels RPC et de quotes sur des paires structurellement mortes.
- Moins de bruit dans `scans.jsonl` et dans les logs de cycle.
- État borné, versionné, lisible et reconstructible.
- Arithmétique exacte en `BigInt`, sans flottants ni arrondis.
- Mode `off` par défaut : aucun changement de comportement tant que le
  filtre n'est pas activé.
- `shadow` permet une calibration sans risque avant `enforce`.
- Le filtre ne touche ni `decide()`, ni les guards, ni le contrat.

### Négatives

- Nouveau fichier d'état à exploiter (`logs/pair_spreads.json`).
- Démarrage à froid : il faut 5 échantillons valides avant que le filtre
  ne puisse rejeter quoi que ce soit.
- En `enforce`, une paire filtrée n'est plus scannée ; son blackout peut
  durer jusqu'à l'ancienneté maximale configurée (24 h par défaut, jusqu'à
  168 h) avant le re-probe automatique.
- La médiane peut mettre jusqu'à une fenêtre complète à intégrer un
  changement de régime ; la confirmation du dernier échantillon atténue
  ce délai pour la récupération, pas pour le rejet.
- Un état corrompu n'est jamais écrasé : l'opérateur doit intervenir, et
  les échantillons du cycle sont perdus.
- Deux cycles concurrents peuvent perdre des échantillons (dernier
  écrivain gagne).
- Le filtre ne fonctionne que si `netProfitBps` est calculable, donc si le
  gaz est pricable dans le token emprunté (stable ou WETH via
  `gasCostInBorrowedToken`) et si le prix ETH/USD est disponible. Les paires
  longtail non pricées restent en fail-open permanent.

### Neutres

- Aucun changement de `DRY_RUN`, des guards, du contrat, des ABI ou des
  dépendances.
- Aucun changement de format de `scans.jsonl` : les paires filtrées n'y
  écrivent pas.
- Aucun changement de `decide()` ni de son contrat.
- En `off`, aucun I/O et aucun nouveau fichier.

## Limites connues et points ouverts

1. **Paires non pricées.** Si `gasCostInToken` est `null` (token emprunté
   ni stable ni WETH, ou gaz/prix ETH indisponible), `netProfitBps` est
   `null`, aucun échantillon n'est enregistré, et le filtre reste fail-open
   pour cette paire. C'est cohérent avec la politique d'optimisation, mais
   le filtre ne sert à rien sur ces paires.
2. **Pas de backfill.** L'historique commence à l'activation. On
   n'importe pas `scans.jsonl`, qui ne contient pas la clé de route stable.
3. **Blackout borné en `enforce`.** Une paire filtrée ne produit plus
   d'échantillon. La récupération rapide (dernier échantillon >= plancher)
   suppose qu'un nouvel échantillon apparaisse ; sinon, il faut attendre
   l'expiration de l'ancienneté maximale configurée (24 h par défaut,
   jusqu'à 168 h). Si un blackout plus court
   est nécessaire, une sonde périodique devra être spécifiée dans un
   nouvel ADR (par exemple, une quote de la plus petite taille tous les N
   cycles, sans exécution).
4. **Biais du maximum.** Le meilleur `netProfitBps` parmi plusieurs tailles
   est un maximum, donc légèrement biaisé vers le haut. Le filtre rejette
   donc moins que ne le ferait une moyenne. C'est acceptable pour une
   optimisation fail-open, mais la médiane n'est pas un estimateur non
   biaisé du profit typique.
5. **Doublons de configuration.** Deux entrées partageant la même clé
   produisent un seul échantillon mais peuvent toujours être scannées deux
   fois. Le filtre ne corrige pas ce défaut de configuration.
6. **Pas de verrou inter-process.** Voir D14.
7. **Multi-hop non couvert.** La clé décrit exactement deux jambes. Si
   P1-18 (multi-hop) est implémenté, la clé et le modèle d'état devront
   être étendus.
8. **Pas de mode par paire.** Le mode est global. Une paire ne peut pas
   être forcée en `off` ou en `enforce` individuellement ; ce serait une
   extension.

## Conditions de réexamen

1. Après la phase `shadow`, si les valeurs provisoires ne sont pas
   satisfaisantes → réviser fenêtre, minimum, ancienneté ou marge.
2. Si un faux négatif en `enforce` est démontré (paire viable filtrée qui
   aurait passé `decide()`) → réexaminer la règle de rejet et la marge.
3. Si la sémantique de `netProfitBps` change (premium, frais, gaz, L1) →
   rouvrir D10.
4. Si `pair.minProfitBps` devient mutable ou si l'adaptive commence à le
   modifier → rouvrir D5.
5. Si P1-18 (multi-hop) est implémenté → étendre la clé et le schéma.
6. Si le rythme des cycles change (passage de `scan.yml` cron à `run.js`
   permanent, ou l'inverse) → revoir fenêtre et ancienneté.
7. Si le fichier d'état grossit anormalement ou si des échantillons sont
   perdus régulièrement à cause de cycles concurrents → ajouter un verrou
   ou un élagage plus agressif.
8. Si un opérateur demande un mode par paire ou une sonde périodique →
   nouvel ADR, pas une extension silencieuse.

## Références

- `bot/scanner.js` — `scanPair`, `scanTradeSize`, `netProfitBps` (`:136-157`,
  `:164-169`, `:257-377`)
- `bot/pricing.js` — `gasCostInBorrowedToken`, `effectiveMinProfitBps`
  (`:11-44`, `:144-148`)
- `bot/config.js` — `PROFILE_BOUNDS`, `validatePairs`, plafond P1-16
  (`:35-39`, `:172-186`, `:268-283`, `:494`)
- `bot/pairSpread.js` — décision pure `decidePairSpread`, clé
  `buildPairKey`, échantillon `bestNetProfitBps`, fenêtre et médiane
- `bot/pairSpreadStore.js` — `loadPairSpreadState`,
  `recordPairSpreadSamples`, écriture atomique et versionnement
- `test/BotPairSpread.test.js`, `test/BotPairSpreadStore.test.js`,
  `test/BotMain.test.js` — couverture ciblée de l'intégration
- `bot/index.js` — boucle de scan, `selectBestResult`, `exitCode`
  (`:63-66`, `:240-334`, `:340`)
- `bot/adaptive.js` — `applyAdaptive`, mise à l'échelle des tailles
  (`:203-264`)
- `bot/guards.js` — `readState`, `writeState` atomique (`:66-89`)
- `bot/persist.js` — `appendScanResult`, écriture atomique
  (`:52-89`, `:140-151`)
- `docs/PRIORITES.md` — P1-16 (`7f1af08`), P1-16-bis, G1, M1-bis
  (`:109`, `:115`, `:236-268`, `:307-360`)
- `bot/ARCHITECTURE.md` — profils, seuil effectif D7, breaker M1-bis
  (`:128-143`, `:374-408`)
- `docs/adr/0001-nonce-manager.md` — pattern d'état persistant et de
  décision documentée
- `docs/adr/0003-log-sweep-regression.md` — `netProfitBps` et sélection
  du meilleur point
- `docs/adr/0004-rpc-error-rate-breaker.md` — fenêtre, fail-open sur état
  absent, écriture atomique
- `docs/adr/0005-gas-anomaly-breaker.md` — fenêtre 20, minimum 5, médiane
  exacte comme précédent

## Résumé des 18 décisions

1. **Source** : `logs/pair_spreads.json`, état dédié et borné, jamais
   partagé avec les guards ou `scans.jsonl`.
2. **Échantillon** : meilleur `netProfitBps` valide obtenu pour une paire
   pendant un cycle, ou aucun échantillon si aucun résultat valide.
3. **Fenêtre** : 20 échantillons par paire.
4. **Activation statistique** : minimum 5 échantillons valides.
5. **Ancienneté maximale** : 24 heures par défaut (valeur provisoire à
   calibrer), configurable jusqu'à 168 heures.
6. **Modes** : `off`, `shadow`, `enforce` ; défaut `off`.
7. **Comparaison** : médiane observée de `netProfitBps` avec
   `pair.minProfitBps`, pas avec le plancher adaptatif.
8. **Rejet** : uniquement si la médiane est strictement inférieure au
   plancher **et** si le dernier échantillon est lui aussi inférieur.
9. **Récupération** : un échantillon récent supérieur ou égal au plancher
   autorise un nouveau scan ; l'expiration de l'ancienneté maximale sert de
   filet de sécurité.
10. **État absent, insuffisant, corrompu ou illisible** : fail-open, scan
    autorisé, warning. Un état corrompu n'est jamais écrasé.
11. **Clé stable** : chainId, tokens, types de jambes, routeurs et
    paramètres V3 pertinents, dont quoter ; adresses en minuscules.
12. **Déduplication** : échantillons dédupliqués par clé, un seul par
    paire et par cycle.
13. **Médiane exacte** : `BigInt`, comparaison sur la médiane doublée,
    aucune division ni flottant.
14. **Aucun double comptage** : premium, frais de pool, gaz et L1 sont
    déjà dans `netProfitBps` ; le filtre ne les re-soustrait pas.
15. **Complémentarité** : le filtre est complémentaire à P1-16 et ne
    remplace jamais `decide()`.
16. **Mode `shadow`** : le scan continue toujours, même en cas de
    would-reject.
17. **Toutes les paires filtrées volontairement** : `exitCode` 0 en
    l'absence d'autre erreur.
18. **Écriture atomique** : au plus une écriture groupée par cycle, après
    la boucle des paires.

---

*Fin de l'ADR 0006. Ce document formalise les décisions de conception.
L'intégration dans le bot, sa configuration et ses tests sont réalisés
séparément et restent soumis à validation avant commit.*
