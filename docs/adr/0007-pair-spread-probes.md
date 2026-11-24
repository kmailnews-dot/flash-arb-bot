# ADR 0007 — Sondes périodiques de spread par paire

- **Statut** : accepté ; implémentation T1–T5 présente dans l'arbre de
  travail (non commitée), tests unitaires et d'intégration présents ;
  validation opérationnelle non effectuée ; activation par défaut
  désactivée ; activation dans GitHub Actions différée.
- **Date** : 2026-11-22
- **Révision** : 2026-11-23 — arbitrages A1–A17, corrections X1–X9 et note
  X10 de l'audit final, puis anomalies F1–F11 de l'audit des probes
  intégrées, y compris l'anomalie F8 (contrat de journalisation), corrigée
  dans cette révision. Révision du 2026-11-24 : statut d'implémentation
  actualisé, décisions D1–D15 inchangées.
- **Contexte** : audit read-only des probes ; réponse à la limite connue n° 3
  et à la condition de réexamen n° 8 de l'ADR 0006.
- **Portée** : document de décision. L'implémentation T1–T5 est présente
  dans l'arbre de travail mais n'est ni commitée ni déployée par cet ADR.
- **Complète** : `docs/adr/0006-pair-spread-filter.md`, sans le modifier.
- **Validation** : arbitrages A1–A17 rendus le 2026-11-23 ; corrections
  F1–F11 intégrées. L'implémentation T1–T5 et les tests unitaires et
  d'intégration D13 sont présents dans l'arbre de travail ; la validation
  opérationnelle reste à effectuer.

> **Note de statut (2026-11-24).** L'implémentation T1–T5 est présente dans
> l'arbre de travail, non commitée : scheduler pur, intégration `main()`,
> Store, backoff/overlay D15 et configuration. Les tests unitaires
> (`test/BotPairSpreadProbe.test.js`,
> `test/ValidatePairSpreadProbeConfig.test.js`) et d'intégration
> (`test/BotPairSpreadProbeIntegration.test.js`) sont présents. Aucune
> validation opérationnelle n'a encore été effectuée, les probes restent
> désactivées par défaut (`intervalMs = 0`) et leur activation dans GitHub
> Actions est différée. Les mentions « à implémenter » ou « non exécuté »
> qui subsistent dans le corps des décisions D1–D15 décrivent l'état au
> moment de leur rédaction ; elles sont levées par la présente mise à jour
> de statut, sans modification des décisions elles-mêmes.

## 1. Résumé

L'ADR 0006 filtre en `enforce` les paires dont la médiane doublée est
sous `2 × plancher` **et** dont le dernier échantillon est sous le
plancher. Une paire filtrée n'est plus
scannée, donc elle ne produit plus d'échantillon : c'est le « blackout »
borné par `PAIR_SPREAD_MAX_AGE_MS` (24 h par défaut). Cet ADR propose des
**sondes** (`probes`) : des quotes read-only, exécutées après la boucle
principale, uniquement pour les paires déjà filtrées en `enforce`, dans le
but de rafraîchir leur historique sans les rescanner à chaque cycle et sans
jamais exécuter de transaction.

Les décisions sont les suivantes :

| ID | Décision | Statut |
|---|---|---|
| D1 | Probes réservées aux paires filtrées en `enforce` ; quotes read-only, aucune exécution. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D2 | Une probe réutilise `scanPair` complet ; aucun `scans.jsonl`, aucun compteur, aucun `maybeExecute`. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D3 | Contrat complet du scheduler (`globalIntervalMs`, `lastGlobalProbeAt`, `suspendedUntil`, `cursorKey`, `pendingAttempts`) : paramètres requis/optionnels et sentinelles, forme de `selected`, `intervalMs === 0 → selected = []`, `maxPerCycle <= 10`, filtre des clés vides ; candidats filtrés en `enforce`, dédupliqués, ordonnés par clé ; départ à la clé immédiatement suivante si `cursorKey` est présent, sinon à la première clé lexicale ; curseur circulaire en mémoire qui ne dépasse aucune clé sélectionnée non résolue (une clé exclue par D5 est résolue). | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D4 | Le skip `enforce` reste inchangé ; une probe réussie avec `bps >= plancher` réactive la paire au cycle suivant. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D5 | Exclusion structurelle : une clé scannée et une clé sondée ne peuvent pas coïncider dans un cycle. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D6 | Scheduler appelé une fois par cycle, sans timer externe ; intervalle en millisecondes. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D7 | Budget : `maxPerCycle` borné à 1–10, intervalle par paire et intervalle global obligatoire dès que les probes sont actives ; capacité nominale, coût RPC et métriques runtime avant `enforce` distingués, sans garantie de rotation. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D8 | Historique persisté reconstruit avec `max(samples[].at, attempts[].at)`, y compris les paires à attempts seules ; overlay `pendingAttempts` appliqué à la sélection ; horodatages persistés et horodatages de scheduler distingués. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D9 | Erreurs de probe classées `failure`/`SCAN_ERROR` ou `empty`, sans effet sur les compteurs, l'`exitCode`, le breaker ni l'adaptive ; logging non bloquant et erreur de classification sans sample. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D10 | Persistance dans le Store v2 existant, `source: "probe"`, un seul commit par cycle ; validité de l'état, indication d'écriture et écriture réellement réussie distinguées. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D11 | Un seul `pairSpreadNow` par cycle pour les samples et attempts ; `lastGlobalProbeAt` reçoit le `probeNow` capturé au début de la phase de probe, pas l'heure réelle de démarrage du batch. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D12 | Trois réglages, désactivés par défaut ; la validation des types, des bornes et du couplage `intervalMs > 0 ⇒ globalIntervalMs > 0` est identique dans tous les modes ; seuls l'exécution des probes et l'avertissement de démarrage dépendent du mode, selon les conditions prévues par D12. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D13 | Tests unitaires (contrat, curseur et annulations, logging/classification), configuration, intégration `BotMain`, Store et panne d'écriture (exceptions de commit incluses). | acceptée ; tests présents dans l'arbre de travail |
| D14 | Aucun changement réseau, contrat, ABI, guard, breaker, `scans.jsonl` ou schéma Store ; invariant d'architecture amendé. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |
| D15 | Panne d'écriture : `commitSucceeded = ok && written`, backoff 5–60 min en plafonds de suspension, récupération anticipée uniquement sur écriture réelle, `pendingAttempts` ré-émis, exceptions de commit inattendues et déterministes distinctes d'un `WRITE_FAILED`, limite explicite après redémarrage. | acceptée ; implémentée dans l'arbre de travail (T1–T5) |

**A1.** Ces décisions sont acceptées comme base d'implémentation. Les
corrections documentaires issues des arbitrages A1–A17 sont intégrées par la
révision du 2026-11-23. L'implémentation T1–T5 et les tests D13 sont présents
dans l'arbre de travail, non commités ; la validation opérationnelle reste à
effectuer. Les arbitrages rendus sont consignés en section 7.

**Profil d'activation retenu.** Les valeurs par défaut restent
désactivées (`intervalMs = 0`). Le profil de première activation est :
`mode = enforce`, `intervalMs = 3600000` (1 h),
`globalIntervalMs = 300000` (5 min), `maxPerCycle = 1`, exécuté d'abord
dans `run.js` (A10). Ce profil n'est pas un défaut implicite : il doit être
configuré explicitement. Cette première activation est une phase de mesure ;
avant de la considérer comme validée en `enforce`, collecter les métriques
runtime définies en D7 (A6), sans seuil numérique fixé par cet ADR.

## 2. Contexte

### 2.1 État factuel (mis à jour le 2026-11-24)

| Élément | État vérifié | Référence |
|---|---|---|
| Branche / HEAD | `main`, `6711a25` (`feat(bot): persist pair spread scan attempts`) ; implémentation T1–T5 non commitée dans l'arbre de travail | `git log -1`, `git status` |
| ADR 0006 | accepté ; D1–D15 de référence ; store v2 et attempts `scan` intégrés | `docs/adr/0006-pair-spread-filter.md` |
| Store v2 | samples + attempts, plafond 20 attempts par paire, sources `scan`/`probe` | `bot/pairSpreadStore.js:22`, `:36` |
| Attempts `scan` | branchées dans le cycle (phase 2B) | `bot/index.js:462-499` |
| Implémentation probe | présente, **non commitée** (T1–T5) : scheduler pur, intervalle global, borne `maxPerCycle <= 10`, historique samples + attempts | `bot/pairSpreadProbe.js` (arbre de travail) |
| Tests probe | présents, **non commités** | `test/BotPairSpreadProbe.test.js`, `test/ValidatePairSpreadProbeConfig.test.js`, `test/BotPairSpreadProbeIntegration.test.js` |
| Config probe | présente, **non commitée** (T1–T5) : trois réglages, `optionalProbeInteger`, couplage `intervalMs > 0 ⇒ globalIntervalMs > 0`, avertissements de capacité, conforme à D12 | `bot/config.js` (arbre de travail) |
| Boucle principale | état chargé une fois par cycle ; `pairSpreadNow` fixé au début | `bot/index.js:258-302` |
| Skip `enforce` | `continue` avant `scanPair` | `bot/index.js:430-440` |
| Commit d'état | un seul `recordPairSpreadCommit` après la boucle | `bot/index.js:587-626` |
| Cycle persistant | `run.js`, `DEFAULT_POLL_INTERVAL_MS = 15000`, cycles non chevauchants | `bot/run.js:6`, `:75-127` |
| Période d'un cycle | `main()` puis `setTimeout(pollIntervalMs)` ; la période réelle est `durée de main() + pollIntervalMs + surcoût`, sans borne supérieure dans le code | `bot/run.js:103-127` |
| Cycle planifié | `scan.yml`, cron `*/5 * * * *`, `DRY_RUN=true`, timeout 15 min, `cancel-in-progress` | `.github/workflows/scan.yml:12-27` |
| Persistance `scan.yml` | seul `logs/scans.jsonl` est uploadé ; `logs/pair_spreads.json` ne survit pas d'un run à l'autre | `.github/workflows/scan.yml:55-63` |
| Défauts du filtre | fenêtre 20, `minSamples` 5, `maxAgeMs` 24 h (max 168 h) | `bot/pairSpread.js:6-8`, ADR 0006 |
| Fenêtre du filtre | `selectWindowSamples` conserve `at >= now - maxAgeMs` et `at <= now` : intervalle fermé `[now - maxAgeMs, now]` | `bot/pairSpread.js:225-258` |
| Coût d'un scan | 3 quotes par taille dans la profondeur (2 pour la profondeur + 1 retour), 2 pour la première taille au-delà, 0 pour les suivantes ; 2 pour la re-quote interpolée si `interp.interpolated === true` | `bot/scanner.js:257-377` |
| Nombre de tailles | `tradeSizes.length` n'a **aucune borne supérieure explicite** (non vide, sans doublon, positif, sous le plafond du profil) ; `logSweep.steps` est borné à 3–20 | `bot/config.js:206-208`, `:227-255`, `:272-279` |
| Throttle RPC | FIFO par throttle, `THROTTLE_MIN_INTERVAL_MS = 250` par défaut ; espace les départs, ne borne ni la file ni le total | `bot/throttle.js:44-78`, `bot/config.js:604` |
| `QUOTE_STALE` | quote plus vieille que `maxQuoteAgeMs` (60 s par défaut) | `bot/scanner.js:319-327` |

Le prototype `bot/pairSpreadProbe.js` est un module pur :

- `initProbeHistoryFromState` reconstruit l'historique à partir des
  **samples uniquement** (`:52-89`) ; c'est le défaut M1 ;
- `selectProbeCandidates` borne `maxPerCycle`, déduplique les clés et
  ordonne les candidats (`:99-152`) ; il filtre déjà l'intervalle par paire
  avant le tri, mais ne connaît ni `scannedKeys`, ni l'intervalle global,
  ni la borne `maxPerCycle <= 10` ;
- `recordProbeAttempt` ne recule jamais un timestamp (`:158-173`) ;
- `intervalMs === 0` désactive les probes (`:116`) ;
- défauts : `DEFAULT_PROBE_INTERVAL_MS = 0`,
  `DEFAULT_PROBE_MAX_PER_CYCLE = 1` (`:6-7`) ;
- `validateProbeMaxPerCycle` n'impose que `>= 1` (`:20-25`), pas `<= 10` ;
- aucun état de panne d'écriture, aucun backoff, aucun `lastGlobalProbeAt`,
  aucun curseur de fairness ;

### 2.2 Le problème que l'ADR 0006 laisse ouvert

L'ADR 0006 documente explicitement la limite :

> **Blackout borné en `enforce`.** Une paire filtrée ne produit plus
> d'échantillon. La récupération rapide (dernier échantillon >= plancher)
> suppose qu'un nouvel échantillon apparaisse ; sinon, il faut attendre
> l'expiration de l'ancienneté maximale configurée (24 h par défaut,
> jusqu'à 168 h). Si un blackout plus court est nécessaire, une sonde
> périodique devra être spécifiée dans un nouvel ADR.
> — `docs/adr/0006-pair-spread-filter.md:1054-1060`

et la condition de réexamen :

> 8. Si un opérateur demande un mode par paire ou une sonde périodique →
>    nouvel ADR, pas une extension silencieuse.
> — `docs/adr/0006-pair-spread-filter.md:1094-1095`

Le présent ADR est cette réponse. Il ne modifie aucune décision de l'ADR
0006 : il ajoute un mécanisme optionnel, désactivé par défaut, qui produit
des échantillons comparables à ceux du scan normal.

### 2.3 Les quatre constats M1–M4

L'audit read-only du prototype a retenu quatre constats. Ils sont formulés
ici en termes observables, indépendamment de la formulation exacte de
l'audit.

| ID | Constat | Défaut observable | Référence prototype |
|---|---|---|---|
| M1 | L'historique ignore les attempts | Après redémarrage, une probe ou un échec récent n'est pas vu ; la même paire peut être re-sondée en boucle et affamer les autres. Les paires à attempts seules sont absentes de l'historique. | `initProbeHistoryFromState` n'utilise que `samples` (`bot/pairSpreadProbe.js:68-87`) |
| M2 | Aucune exclusion structurelle scan/probe | Si la liste de candidats est calculée avant les décisions, une paire peut être scannée **et** sondée dans le même cycle : deux fois le coût RPC, deux observations au même `at`, risque de conflit de commit. | pas de `scannedKeys` dans le prototype |
| M3 | Budget global non borné | `maxPerCycle` borne un appel, pas la fréquence des appels. Avec `run.js` à 15 s de délai de polling et `maxPerCycle = 1`, le scheduler peut lancer jusqu'à 5 760 probes par jour ; avec `maxPerCycle = 10`, jusqu'à 57 600. Ce sont des **probes**, pas des requêtes RPC : chaque probe coûte plusieurs quotes, et la durée réelle des cycles réduit ces bornes. | `selectProbeCandidates` ne connaît que `maxPerCycle` (`:99-152`) |
| M4 | Sémantique d'erreur, d'horodatage, de persistance et de panne d'écriture non spécifiée | Une probe en échec peut faire échouer le cycle, incrémenter les compteurs ou produire un second commit ; deux horloges différentes peuvent créer des échantillons incohérents ; `loaded.writable` ne prouve pas qu'une écriture réussira. | prototype pur, aucune intégration dans `bot/index.js` |

Les sections suivantes répondent à ces quatre constats et aux quinze
points demandés.

## 3. Objectif et périmètre

### 3.1 Objectif

Rafraîchir périodiquement l'historique des paires **déjà filtrées en
`enforce`**, afin qu'une paire structurellement viable puisse sortir du
blackout sans attendre l'expiration de `PAIR_SPREAD_MAX_AGE_MS`, tout en :

- bornant la cadence des batchs et le nombre de probes, sans borne
  démontrable sur le nombre de requêtes RPC ;
- ne modifiant ni la règle de décision, ni les guards, ni l'exécution ;
- restant désactivé par défaut et réversible par configuration ;
- produisant des échantillons comparables à ceux du scan normal ;
- conservant un seul fichier d'état et un seul commit par cycle.

### 3.2 Dans le périmètre

- Un scheduler pur, sans I/O, appelé une fois par cycle.
- La sélection des candidats parmi les paires filtrées en `enforce`, avec un
  curseur circulaire de fairness en mémoire.
- L'exécution de probes read-only via `scanPair`, après la boucle
  principale.
- La classification des résultats de probe en sample, `empty` ou
  `failure`.
- La persistance des samples et attempts de probe dans le Store v2
  existant.
- Trois réglages de configuration, dont l'activation est désactivée par
  défaut : intervalle par paire, intervalle global et `maxPerCycle`.
- Le modèle de capacité et de coût RPC : capacité nominale, cadence réelle
  des batchs, période par paire, absence de borne supérieure de rotation et
  risque de dépassement de `maxAgeMs`.
- La gestion de la panne d'écriture : backoff en mémoire, rotation des
  candidats et suspension temporaire des probes, avec `commitSucceeded`
  et ré-émission des attempts en attente.
- Les tests unitaires, de configuration, d'intégration et de panne
  d'écriture associés.

### 3.3 Hors périmètre

- Toute transaction, tout envoi, toute signature, tout appel à
  `maybeExecute` depuis une probe.
- Toute modification de `contracts/FlashArbExecutor.sol`, de l'ABI, des
  guards, du breaker, de `decide()` ou de l'adaptive.
- Toute modification de `scans.jsonl` ou de son format.
- Tout nouveau fichier d'état, tout nouveau schéma, toute migration de
  store.
- Tout backfill depuis `scans.jsonl`.
- Tout mode par paire, tout multi-hop, tout verrou inter-process.
- Toute modification de l'ADR 0006.

## 4. Vocabulaire : scan et probe

Le mot « probe » ne doit pas être confondu avec le scan normal. Les deux
appellent `scanPair`, mais leurs effets et leur contrat diffèrent.

| Aspect | Scan normal | Probe |
|---|---|---|
| Déclencheur | paire non filtrée dans la boucle principale | paire filtrée en `enforce`, après la boucle |
| But | détecter une opportunité et produire un sample | rafraîchir l'historique uniquement |
| Appel | `scanPair` complet | `scanPair` complet, mêmes paramètres |
| `scans.jsonl` | oui, un enregistrement par résultat | **non** |
| Compteurs `scanned` / `opportunities` | oui | **non** |
| `maybeExecute` | oui si `isOpportunity` | **jamais** |
| Samples | oui, si `bestNetProfitBps` valide | oui, si `bestNetProfitBps` valide |
| Attempts | oui, `source: "scan"` | oui, `source: "probe"` |
| `rpcErrors` / `pairErrors` | oui | **non** |
| `exitCode` | peut contribuer à l'échec | **jamais** |
| Horloge | `pairSpreadNow` (cycle) | `pairSpreadNow` pour l'éligibilité et les `at` ; `probeNow` pour le throttle et la suspension, jamais persisté |
| Coût RPC | plusieurs quotes par taille | plusieurs quotes par taille, coût variable selon `tradeSizes.length` |

Une probe est donc un **scan sans effets de bord métier** : mêmes quotes,
même calcul de `netProfitBps`, mais aucune conséquence sur l'exécution, les
journaux de scan ou les compteurs du cycle.

## 5. Décisions

Chaque décision est présentée avec sa justification, ses conséquences et
les hypothèses qu'elle requiert. Les décisions D1–D15 sont **acceptées comme
base d'implémentation** (A1). L'implémentation T1–T5 et ses tests sont
présents dans l'arbre de travail ; la validation opérationnelle n'est pas
effectuée. Les corrections issues des arbitrages A1–A17 sont intégrées dans
le texte.

### D1 — Probes réservées aux paires filtrées en `enforce`

**Décision.** Une probe n'est autorisée que pour une paire dont
`pairDecision.skip === true` et dont le mode effectif est `enforce`. Aucune
probe n'est exécutée en `off` ou en `shadow`. Une probe ne fait que des
quotes read-only : elle ne peut ni exécuter, ni soumettre, ni signer.

**Justification.** Le blackout n'existe qu'en `enforce` : en `shadow`, la
paire est scannée normalement, donc elle produit déjà des samples ; en
`off`, l'état n'est même pas chargé (`bot/index.js:261`). Sonder une paire
non filtrée doublerait le coût RPC sans bénéfice.

**Conséquences.**

- Une paire avec `INSUFFICIENT_SAMPLES`, `INVALID_FLOOR` ou
  `INVALID_SAMPLES` n'est **pas** candidate : elle reste scannée
  normalement (fail-open) et produit ses samples par le scan.
- Une paire filtrée pour cause de `PAIR_SPREAD_BELOW_FLOOR` est candidate.
- Les paires désactivées par configuration ne sont pas dans
  `configuredPairs` ; elles ne sont donc jamais candidates.

**Hypothèses.** `pairDecision.skip` est le signal autoritaire du blackout ;
il est calculé avant le scan et n'est pas modifié par la probe.

### D2 — Une probe réutilise `scanPair` complet

**Décision.** Une probe appelle le même `scanPair` que le scan
normal — ou la même implémentation injectée `scanPairImpl` — avec la même
paire, le même `executionConfig`, le même `gasPriceWei`, le même
`ethUsdPrice` et le même `blockTag` de cycle. Elle calcule ensuite
`bestNetProfitBps(results)` et `classifyEmptyScan(results)`.
Elle ne journalise pas dans `scans.jsonl`, n'incrémente aucun compteur et
n'appelle jamais `maybeExecute`.

**Justification.** Le filtre compare des `netProfitBps` issus du **meilleur
résultat parmi toutes les tailles**. Une probe qui ne quoterait qu'une
seule taille produirait une métrique différente, au plus égale au meilleur
`bps` et souvent plus basse, et ne pourrait pas réactiver une paire de
façon fiable. Réutiliser `scanPair` garantit que l'échantillon de probe est
comparable à un échantillon de scan et évite une seconde implémentation de
quoting.

**Conséquences.**

- Le coût d'une probe suit le même modèle que celui d'un scan : plusieurs
  quotes par taille retenue, plus la re-quote interpolée **uniquement si
  `interp.interpolated === true`**. Ce n'est pas un coût fixe : il dépend de
  `tradeSizes.length` (non borné) et des résultats de profondeur (D7).
- Une probe peut durer plusieurs secondes et allonger le cycle ; le budget
  de D7 est donc indispensable.
- Si la probe s'exécute longtemps après le début du cycle, `scanPair` peut
  produire `QUOTE_STALE` ; ce cas est traité comme `empty` (D9), pas comme
  une erreur de cycle.
- Les logs internes existants de `scanPair` (par exemple l'échec de
  re-quote interpolée) restent possibles ; ils ne doivent pas être
  transformés en erreur de cycle.

**Hypothèses.** `scanPair` est read-only du point de vue métier : il ne
persiste rien, n'exécute rien et ne modifie pas l'état du filtre. C'est le
cas au moment de la rédaction (`bot/scanner.js:257-377`).

**Alternative rejetée.** L'ADR 0006 suggérait « une quote de la plus petite
taille tous les N cycles ». Cette option est moins coûteuse, mais elle
introduit un biais de taille : le plus petit trade n'est pas le meilleur
trade, et un échantillon plus bas peut maintenir le filtre actif à tort.
Elle est examinée en section 6.

### D3 — Sélection des candidats

**Décision.** Le scheduler est une fonction pure
`selectProbeCandidates(contract)` dont le contrat est canonique et complet.
Toute référence au scheduler dans cet ADR (D7, section 8, D13) utilise
exactement ce contrat :

```
selectProbeCandidates({
  // requis
  candidates,          // [{ key, pair }] — paires filtrées en enforce
  history,             // Map<key, at persisté> — samples + attempts persistés
  pairSpreadNow,       // entier sûr >= 0 — horloge des at persistés
  probeNow,            // entier sûr >= 0 — horloge réelle du processus
  intervalMs,          // entier sûr >= 0 ; 0 désactive les probes
  globalIntervalMs,    // entier sûr >= 0
  lastGlobalProbeAt,   // entier sûr >= 0 ou null
  suspendedUntil,      // entier sûr >= 0 ; 0 = aucune suspension
  maxPerCycle,         // entier 1..10 inclus
  cursorKey,           // chaîne non vide ou null
  // optionnels
  scannedKeys,         // Set<string> ; défaut : Set vide
  probedKeys,          // Set<string> ; défaut : Set vide
  pendingAttempts      // Map<key, { key, at, outcome, source, reason? }> ;
                       // défaut : Map vide
}) -> {
  selected,            // [{ key, pair, lastAt }] — nouveau tableau
  nextCursorKey        // chaîne non vide ou null
}
```

`history` ne contient que les observations **persistées** (samples et
attempts du Store). L'overlay `pendingAttempts` est appliqué par le
scheduler selon D8 :
`lastAt(key) = max(history.get(key) ?? -1, pendingAttempts.get(key)?.at ?? -1)`.
La suspension (`suspendedUntil`, D15) et le throttle global
(`globalIntervalMs`, `lastGlobalProbeAt`, D7) sont traités en préambule
(étapes 0–2 ci-dessous) avec `probeNow` : ils ne consomment aucun slot et ne
modifient pas le curseur. L'éligibilité par paire utilise `pairSpreadNow`
(voir ci-dessous).

**Paramètres requis, optionnels et sentinelles.**

- `candidates` est requis et doit être un tableau. Chaque élément doit être
  un objet `{ key, pair }` ; `pair` est l'objet de la paire. Un élément
  `null`, non-objet ou tableau est une **erreur** de contrat. Une entrée
  dont `key` n'est pas une chaîne non vide est **ignorée** par le filtre de
  l'étape 3, pas une erreur : c'est la défense contre une clé `buildPairKey`
  instable (voir Conséquences) ; son `pair` n'est alors pas validé. Si `key`
  est une chaîne non vide mais que `pair` est absent, `null`, tableau ou
  non-objet, c'est une **erreur** de contrat, jamais une entrée
  silencieusement ignorée. Un conteneur `candidates` qui n'est pas un
  tableau est une erreur.
- `history` est requis et doit être une `Map`. Une clé absente signifie
  « aucune observation persistée » ; l'absence est la seule représentation
  permise, la valeur `-1` n'est pas stockée dans l'entrée. Les valeurs sont
  des entiers sûrs `>= 0`. Une valeur invalide est une erreur.
- `pendingAttempts` est optionnel ; absent, il vaut une `Map` vide. S'il est
  fourni, c'est une `Map` dont chaque valeur est un attempt complet
  `{ key, at, outcome, source, reason? }` avec `at` entier sûr `>= 1`,
  `outcome` dans `success`/`empty`/`failure`, `source` dans `scan`/`probe`
  (D8, D15). La clé de la `Map` et `entry.key` doivent être **identiques** :
  une incohérence `mapKey !== entry.key` est une erreur, pas une
  réindexation silencieuse. Une valeur invalide est une erreur.
- `scannedKeys` et `probedKeys` sont optionnels ; absents, ils valent un
  `Set` vide. S'ils sont fournis, ce sont des `Set` de chaînes non vides.
- `pairSpreadNow` et `probeNow` sont requis : entiers sûrs `>= 0`. Aucun
  ordre entre les deux n'est exigé ; une horloge qui recule est traitée par
  D7 et D15.
- `intervalMs` et `globalIntervalMs` sont requis : entiers sûrs `>= 0`.
  `intervalMs = 0` est la sentinelle « probes désactivées » ;
  `globalIntervalMs = 0` est la sentinelle « pas de throttle global » au
  niveau pur (D7, D12).
- `lastGlobalProbeAt` est requis : entier sûr `>= 0` ou `null`. `null` est
  la seule sentinelle « aucun batch démarré » ; `0` est un timestamp
  valide, pas une sentinelle.
- `suspendedUntil` est requis : entier sûr `>= 0`. `0` est la sentinelle
  « aucune suspension » ; `null` n'est pas accepté.
- `maxPerCycle` est requis : entier `1..10` inclus. `0`, `11` et toute
  valeur hors bornes sont rejetés (D7, D12, D13).
- `cursorKey` est requis : chaîne non vide ou `null`. `null` est la seule
  sentinelle « démarrer à la première clé lexicale » ; la chaîne vide est
  invalide et n'est pas convertie en `null`.

**Forme de `selected`.** `selected` est un nouveau tableau, dans l'ordre de
parcours circulaire — à partir de la clé immédiatement suivante si
`cursorKey` est présent, sinon à partir de la première clé lexicale, avec
wrap —, et non un tableau globalement trié. Chaque élément est un nouvel
objet
`{ key, pair, lastAt }` :

- `key` : la clé canonique, chaîne non vide ;
- `pair` : la référence de la **première** occurrence du candidat de cette
  clé (étape 4) ; le scheduler ne la clone pas et ne la mute pas ;
- `lastAt` : le maximum
  `max(history.get(key) ?? -1, pendingAttempts.get(key)?.at ?? -1)` utilisé
  pour l'éligibilité ; `-1` signifie « jamais observée » : la paire n'a
  jamais été sondée et elle est éligible sans appliquer le filtre
  d'intervalle. `lastAt` est une valeur informative, jamais un `at` à
  persister : les samples et attempts sont horodatés avec
  `pairSpreadNow` (D11).

Le tableau `selected` ne contient aucune entrée rejetée par le filtre des
clés vides, la déduplication, l'exclusion D5, le contrôle de futur ou le
filtre d'intervalle. Le **parcours**, lui, examine toutes les clés uniques
non vides, y compris les clés non éligibles et les clés exclues par D5 :
elles ne sont pas supprimées avant le parcours. `selected` est vide si le
préambule bloque, si `intervalMs = 0` ou si aucun candidat n'est éligible.

**Validation et ordre.** Tous les paramètres sont validés (types,
sentinelles, bornes) **avant** le préambule : `maxPerCycle = 11` est rejeté
même si `intervalMs = 0`. Le scheduler applique ensuite exactement cet ordre
(D7 utilise la même numérotation) :

0. si `probeNow < suspendedUntil`, retourner
   `{ selected: [], nextCursorKey: cursorKey }` (D15) ;
1. si `intervalMs === 0`, retourner
   `{ selected: [], nextCursorKey: cursorKey }` : les probes sont
   désactivées et `selected = []` ; `maxPerCycle` et `globalIntervalMs`
   sont inertes à l'exécution mais ont déjà été validés ;
2. si `globalIntervalMs > 0` et `lastGlobalProbeAt !== null` et
   `probeNow - lastGlobalProbeAt < globalIntervalMs`, retourner
   `{ selected: [], nextCursorKey: cursorKey }` : un batch sélectionné mais
   non démarré ne met pas à jour `lastGlobalProbeAt` (D6, D7) ;
3. filtrer les candidats dont `key` n'est pas une chaîne non vide ; ces
   entrées sont ignorées sans consommer de slot ;
4. dédupliquer par clé, en conservant la première occurrence ;
5. pour chaque clé unique, calculer
   `lastAt(key) = max(history.get(key) ?? -1, pendingAttempts.get(key)?.at ?? -1)`
   (D8) et **marquer** son éligibilité sans la retirer de la liste :
   - une clé jamais sondée (`lastAt === -1`) est éligible sans appliquer
     le filtre d'intervalle ni le contrôle de futur (hors exclusion D5) ;
     la sentinelle n'est pas un horodatage et ne participe à aucune
     soustraction ;
   - pour une clé déjà observée (`lastAt >= 0`), non éligible si
     `lastAt > pairSpreadNow` (horodatage futur non fiable) ;
   - pour une clé déjà observée, non éligible si
     `pairSpreadNow - lastAt < intervalMs` ;
   - non éligible si la clé est dans `scannedKeys` (D5) ou dans
     `probedKeys` (défense en profondeur) ;
   - éligible sinon.
   Une clé non éligible reste dans la liste et sera **examinée** pendant le
   parcours ; elle ne consomme simplement pas de slot. Une clé exclue par
   D5 est examinée et **résolue** (D3, « Résolution ») ;
6. ordonner **toutes** les clés uniques par ordre lexicographique croissant
   (ordre total stable, indépendant de l'ordre du fichier et des
   insertions) ;
7. parcourir cet ordre circulairement, sans répétition, à partir de la clé
   de départ définie ci-dessous ; pour chaque clé examinée, la retenir si
   elle est éligible, jusqu'à `maxPerCycle` sélections ; une clé non
   éligible ou exclue par D5 est examinée sans consommer de slot ;
8. retourner `{ selected, nextCursorKey }`, où `nextCursorKey` est la
   **dernière clé examinée** (voir ci-dessous). Si la liste des clés
   candidates est vide, `nextCursorKey = cursorKey`.

Le filtre d'intervalle par paire et l'exclusion D5 sont donc **calculés
avant** le parcours, mais ne suppriment aucune clé de la liste : ils
déterminent seulement l'éligibilité pendant le parcours. Une paire trop
récente ou exclue par D5 ne consomme pas de slot et n'influence pas l'ordre
des autres. L'algorithme retenu **ne trie pas** par `lastAt` ; `lastAt` ne
sert qu'à l'éligibilité (voir le paragraphe historique ci-dessous).

**Horloge de l'éligibilité par paire.** Les samples et attempts de probe
sont horodatés avec `pairSpreadNow` (D11), et le commit utilise
`now = pairSpreadNow`. L'éligibilité et le contrôle de futur (étape 5)
utilisent donc `pairSpreadNow`, jamais `probeNow`. Sinon, l'écart
entre deux `at` d'une même paire pourrait être inférieur à `intervalMs`
lorsque `probeNow - pairSpreadNow` varie d'un cycle à l'autre : une boucle
de scan longue au cycle `t+1` rendrait éligible une paire dont le `at`
précédent est pourtant trop récent sur la timeline persistée. Avec
`pairSpreadNow`, le contrôle porte sur le même écart que celui inscrit dans
les `at` : l'écart entre l'attempt précédent et le nouvel attempt est au
moins `intervalMs`. `probeNow` reste l'horloge de l'enveloppe — suspension
et throttle global —, qui mesure le temps réel du processus et non les `at`
persistés.

**Rotation équitable : curseur circulaire.**

Le présent paragraphe décrit l'**ancien comportement** du prototype, qui
triait les candidats par `lastAt` croissant puis par clé. Ce n'est plus
l'algorithme retenu : l'algorithme actuel (étapes 0–8) **marque**
l'éligibilité sans retirer les clés, trie toutes les clés uniques par clé
croissante, puis parcourt circulairement à partir de la clé de départ ;
`lastAt` ne sert qu'à l'éligibilité. Dans l'ancien tri, à `lastAt` égal, la
clé la plus petite passait toujours en premier, et une paire récemment
sondée pouvait être reléguée indéfiniment si de nouvelles clés
apparaissaient. Le curseur corrige ce biais historique.

**Définitions du parcours.** Ces termes sont disjoints et ne doivent pas
être confondus :

- **clé candidate** : clé unique et non vide issue de `candidates`, après
  déduplication ; elle reste candidate même si elle est non éligible ou
  exclue par D5 ;
- **clé examinée** : clé visitée par le parcours circulaire ; chaque clé
  candidate est examinée au plus une fois par appel ;
- **clé éligible** : clé examinée qui satisfait le contrôle de futur, le
  filtre d'intervalle et l'exclusion D5 ; seule une clé éligible peut être
  sélectionnée ;
- **clé sélectionnée** : clé éligible retenue dans `selected`, dans l'ordre
  du parcours, jusqu'à `maxPerCycle` ;
- **probe commencée** : entrée effective dans le wrapper d'exécution,
  après le contrôle D5 et après ajout à `probedKeys`, immédiatement avant
  `scanPair` ;
- **clé résolue** : pour une clé sélectionnée, clé exclue par D5 juste avant
  l'appel ou probe commencée ; pour une clé examinée mais non sélectionnée,
  la clé est résolue du seul fait qu'elle a été examinée, car aucune probe
  ne peut rester en attente pour elle ;
- **clé non résolue** : clé sélectionnée qui n'a été ni exclue par D5 juste
  avant l'appel, ni commencée ; c'est le seul cas qui doit rester devant le
  curseur runtime.

**Point de départ.** La liste est triée par clé croissante. Si `cursorKey`
est `null` **ou** ne figure plus dans la liste des clés candidates, le
parcours commence à la **première clé lexicale**. Si `cursorKey` figure
dans la liste, le parcours commence à la clé **immédiatement suivante**
dans l'ordre lexical ; si `cursorKey` est la dernière clé, le parcours
revient à la première (wrap). Le parcours ne commence donc jamais sur
`cursorKey` lui-même lorsque celui-ci est présent, sauf s'il n'existe
qu'une seule clé candidate : cette clé unique est alors examinée une fois,
sans répétition.

**Parcours et arrêt.** Le parcours examine les clés dans l'ordre circulaire,
sans répétition, et s'arrête dès que `maxPerCycle` clés ont été
sélectionnées. Une clé non éligible ou exclue par D5 est examinée sans
consommer de slot. Si le tour complet se termine sans atteindre
`maxPerCycle`, toutes les clés candidates ont été examinées. Lorsque le
parcours complet revient à sa clé de départ, il ne la réexamine pas : la
dernière clé examinée est la clé **immédiatement précédente** dans l'ordre
circulaire. Si la clé de départ est la première clé lexicale, c'est la
dernière clé lexicale ; si la clé de départ suit `cursorKey`, c'est
`cursorKey`.

**`nextCursorKey`.** `nextCursorKey` est toujours la **dernière clé
examinée**, et non la dernière clé sélectionnée par principe. Les cas
obligatoires sont :

1. **Aucune clé candidate** : `nextCursorKey = cursorKey`, le curseur
   précédent est conservé.
2. **Clés candidates, aucune éligible** : toutes les clés sont examinées ;
   `nextCursorKey` est la dernière clé du parcours, c'est-à-dire la clé
   immédiatement précédente de la clé de départ (ou `cursorKey` si le
   parcours a commencé après lui). Le batch est vide.
3. **Arrêt après `maxPerCycle` sélections** : le parcours s'arrête
   immédiatement après la dernière sélection ; `nextCursorKey` est cette
   dernière clé sélectionnée, qui est aussi la dernière clé examinée.
4. **Clé exclue par D5** : elle est examinée et résolue ; elle peut être
   dépassée et ne consomme pas de slot.
5. **Clé sélectionnée mais non commencée après annulation** : elle reste
   **non résolue** ; le curseur runtime ne doit pas la dépasser, même si
   `nextCursorKey` la dépasse. La règle de mise à jour ci-dessous prévaut.
6. **Clé non sélectionnée** : elle peut être dépassée si elle a été
   examinée, car elle est alors résolue ; si le parcours s'est arrêté avant
   de l'examiner, le curseur s'arrête avant elle.

- **Propriétaire.** `bot/index.js` possède `cursorKey` dans le runtime de
  probes (D6), à côté de `lastGlobalProbeAt`, `writeFailures`,
  `suspendedUntil` et `pendingAttempts`. Le module
  `bot/pairSpreadProbe.js` reste pur : il reçoit `cursorKey` et retourne
  `nextCursorKey`, sans lire ni écrire d'état global.
- **Initialisation.** `cursorKey = null` au chargement du module. Le
  premier batch commence à la première clé lexicale.
- **Mise à jour.** `bot/index.js` ne copie pas `nextCursorKey` avant
  d'exécuter les probes. Il tient `lastResolvedKey` et `resolvedCount`
  pendant la boucle, puis applique la règle de résolution ci-dessous.
  L'invariant porte sur les **clés sélectionnées non résolues** : le curseur
  runtime ne dépasse aucune clé de `selected` qui n'est pas résolue. Il peut
  dépasser toute clé résolue, y compris une clé exclue par D5 (résolue sans
  être commencée) et toute clé non sélectionnée qui a été examinée. Les clés
  non résolues forment un suffixe de l'ordre de parcours, car les probes
  sont exécutées séquentiellement.
- **Règle de mise à jour après la boucle.**
  - si `selected` est vide : `cursorKey = nextCursorKey` (le parcours a
    examiné des clés ou il n'y avait aucune clé candidate ; aucune probe à
    protéger) ;
  - sinon, si aucune clé n'est résolue : `cursorKey` reste inchangé ;
  - sinon, si toutes les clés sélectionnées sont résolues :
    `cursorKey = nextCursorKey` ;
  - sinon : `cursorKey = lastResolvedKey`.
  Cette règle laisse devant le curseur les clés sélectionnées non résolues ;
  elles seront resélectionnées au cycle suivant. Les clés exclues par D5
  sont résolues et peuvent être dépassées : elles ne doivent pas bloquer la
  rotation. Aucune clé non résolue n'est dépassée, même si `nextCursorKey`
  a été calculé après elle.
- **Annulation.** Une annulation est toute sortie de la boucle de probe
  avant l'entrée dans le wrapper d'une clé sélectionnée, quelle qu'en soit la
  cause (exception, arrêt du cycle). Le mécanisme d'interruption n'est pas
  spécifié par cet ADR ; seule la règle de curseur l'est. Le tableau suivant
  fixe le comportement :

  | Situation | Curseur | Attempt / sample | `pendingAttempts` |
  |---|---|---|---|
  | Annulation avant le premier appel, aucune probe commencée | inchangé si aucune clé résolue ; sinon `lastResolvedKey` | aucun attempt pour les clés non commencées | inchangé |
  | Annulation après le début d'au moins une probe | `lastResolvedKey` si des clés restent non résolues ; sinon `nextCursorKey` | les probes commencées ont leur attempt ; les non commencées n'en ont pas | les attempts des probes commencées suivent D15 |
  | Échec de probe (`scanPair` lève) | la clé est commencée et résolue ; le curseur peut avancer | `failure`/`SCAN_ERROR`, aucun sample | attempt conservé comme les autres |
  | Échec de persistance (`WRITE_FAILED`) | toutes les probes commencées sont résolues ; le curseur avance selon la règle | attempts du cycle conservés | fusionnés dans `pendingAttempts` (D15) |

  Une clé exclue par D5 est résolue sans être commencée : elle peut être
  dépassée, mais elle ne produit ni attempt ni sample. Une clé sélectionnée
  non commencée reste non résolue et ne peut pas être dépassée.
- **Après un échec de persistance.** Le curseur est en mémoire et n'est pas
  affecté par `WRITE_FAILED` : les probes commencées sont résolues, et les
  clés exclues par D5 le sont aussi (sauf annulation, traitée ci-dessus),
  donc la rotation doit avancer. `pendingAttempts` (D15) conserve les
  attempts du cycle échoué pour que les mêmes clés ne repassent pas
  immédiatement en tête.
- **Après redémarrage.** `cursorKey = null`, car il n'est pas persisté. Le
  premier batch repart à la première clé ; les `lastAt` persistés (D8)
  empêchent de sonder trop tôt les paires récentes, mais une paire à clé
  basse et ancienne peut être favorisée au premier batch. La fairness n'est
  donc **pas** garantie à travers un redémarrage ni entre deux exécutions
  `scan.yml`. La persister exigerait un changement de schéma ou un second
  fichier, hors périmètre (D14).

**Sémantique exacte du curseur.** Le curseur de sélection (`nextCursorKey`)
et le curseur runtime (`cursorKey`) sont distincts :

- `nextCursorKey` est calculé par le scheduler pur selon les règles
  ci-dessus ; il ne protège aucune probe non commencée.
- Le curseur runtime est calculé par `bot/index.js` après la boucle selon la
  règle de résolution ; il ne dépasse jamais une clé sélectionnée non
  résolue. C'est lui qui garantit A17.
- Un batch vide ne consomme aucun slot et ne met pas à jour
  `lastGlobalProbeAt` (D6), mais il peut mettre à jour le curseur runtime
  avec `nextCursorKey` (aucune probe à protéger). C'est voulu : une clé
  définitivement inéligible ne doit pas bloquer les suivantes.

**Garanties réelles de fairness.**

- Avec un ensemble de candidats fixe, toutes les clés éligibles à chaque
  batch, `M <= N`, et des batchs successifs exécutés jusqu'au bout, chaque
  clé est sélectionnée au moins une fois dans toute fenêtre de `ceil(N/M)`
  batchs consécutifs ; l'écart entre deux sélections d'une même clé est
  compris entre `floor(N/M)` et `ceil(N/M)` intervalles de batch. Une
  annulation avant le début d'une probe laisse devant le curseur une clé
  sélectionnée **non résolue** et la fait resélectionner au batch suivant :
  l'écart peut être allongé, mais aucune clé non résolue n'est sautée. Une
  clé exclue par D5 est résolue et peut être dépassée. Ce n'est **pas** une
  garantie en temps absolu : les intervalles de batch ne sont pas bornés
  (D7).
- Si des clés sont inéligibles, elles sont examinées sans consommer de slot ;
  une clé candidate est examinée au plus une fois par tour complet, mais le
  nombre de batchs par tour dépend des éligibilités et de `M`.
- Aucune garantie de période maximale : une suspension (`suspendedUntil`),
  un cycle long, un redémarrage ou un changement de `N_candidates` peut
  allonger la rotation sans limite démontrable.
- Aucune garantie de fairness persistante : le curseur est uniquement en
  mémoire. C'est une limite explicite, pas une propriété à promettre.

**Justification.** Le skip `enforce` est la seule condition qui crée un
blackout. La déduplication corrige le cas de deux entrées de configuration
partageant la même clé (limite connue n° 5 de l'ADR 0006). À ensemble de
candidats fixe, le curseur empêche qu'une clé soit systématiquement
favorisée par sa position alphabétique ou par l'ordre du fichier de
configuration, tant que le processus tourne et que les batchs ont lieu. Il
remplace l'ancien tri par `lastAt` du prototype qui, à timestamp égal,
favorisait les clés basses.

**Conséquences.**

- Les routeurs, les `kind`, les frais V3, les quoters, les tokens et le
  `chainId` font partie de la clé canonique (`buildPairKey`,
  `bot/pairSpread.js:81-108`). Deux entrées qui diffèrent par un routeur
  ont donc deux clés distinctes : ce ne sont **pas** des doublons, et
  chacune peut être candidate.
- Les champs exclus de la clé sont `label`, `profile`, `tradeSizes`,
  `minProfitBps` et `tokenOut`. Deux entrées de même clé peuvent donc
  différer par les tailles de trade ou par le plancher. Une seule probe est
  émise ; la première occurrence fournit les paramètres de quote. Si les
  `minProfitBps` diffèrent, les décisions peuvent différer ; si l'une des
  entrées est scannée, `scannedKeys` contient la clé et la probe est
  abandonnée. C'est un défaut de configuration à corriger, pas un
  comportement à masquer.
- Une paire sans clé stable (erreur de `buildPairKey`) n'est pas candidate :
  son entrée est ignorée par le filtre des clés vides (étape 3), sans faire
  échouer les probes des autres paires ; elle reste scannée normalement.
- La liste des candidats est au plus égale à `N_config = config.pairs.length`
  (borne supérieure du nombre de clés uniques) ; le nombre réellement filtré
  `N_candidates(t)` est observé au cycle et peut être plus faible. Le
  curseur ne garantit rien sur `N_candidates(t)`.

**Hypothèses.** La clé `buildPairKey` est stable pour une même route et un
même `chainId` ; c'est l'invariant de l'ADR 0006.

### D4 — Effet sur le filtre et réactivation

**Décision.** Le skip `enforce` reste **inchangé** : une paire
filtrée n'est pas scannée dans le cycle courant. Les probes sont exécutées
**après** la boucle principale. Une probe réussie produit un sample au
`pairSpreadNow` du cycle. Au cycle suivant, `decidePairSpread` applique
exactement la règle D5 de l'ADR 0006 :

- `last` est l'échantillon valide de plus grand `at` après filtrage
  d'ancienneté et troncature de fenêtre ;
- `medianBelow = doubledMedian < 2 × floor` ;
- `lastBelowFloor = last < floor` ;
- `skip = enforce && medianBelow && lastBelowFloor` ;
- raisons : `LAST_AT_OR_ABOVE_FLOOR` si `medianBelow` et
  `!lastBelowFloor` ; `MEDIAN_AT_OR_ABOVE_FLOOR` si `!medianBelow` ;
  `PAIR_SPREAD_BELOW_FLOOR` si les deux.

Conséquences d'une probe :

1. **`bps >= floor`.** Le sample devient le dernier (son `at` est le plus
   récent). `lastBelowFloor` est faux, donc `skip = false`. La paire est
   rescannée au cycle suivant. La raison est `LAST_AT_OR_ABOVE_FLOOR` si la
   médiane reste sous le plancher, `MEDIAN_AT_OR_ABOVE_FLOOR` si elle est
   au-dessus.
2. **`bps < floor`.** Le sample ne peut jamais déclencher la voie
   `LAST_AT_OR_ABOVE_FLOOR`. Il ne peut réactiver la paire que si la médiane
   de la fenêtre résultante est au moins égale au plancher
   (`MEDIAN_AT_OR_ABOVE_FLOOR`) ; cette condition dépend des autres
   échantillons, pas du seul sample de probe. Si la médiane reste sous le
   plancher, la paire reste filtrée (`PAIR_SPREAD_BELOW_FLOOR`). Le plan de
   tests D13 couvre explicitement ce scénario.
3. **`empty` ou `failure`.** Aucun sample ; la décision est inchangée.

**Précision sur l'éviction de fenêtre.** La fenêtre est tronquée aux
`windowSize` échantillons les plus récents. Un sample sous le plancher peut,
dans un cas de bord, faire remonter la médiane au-dessus du plancher en
évincant un échantillon plus ancien et plus bas. Ce n'est pas une
réactivation par la voie `LAST` : c'est la règle médiane de l'ADR 0006 qui
s'applique, et le sample de probe n'y suffit pas à lui seul. L'ADR ne crée
donc pas de règle spéciale ; il documente ce cas pour éviter une lecture
absolue erronée.

**Justification.** Cette règle réutilise exactement la récupération D5 de
l'ADR 0006 : le dernier échantillon au-dessus du plancher suffit à lever le
filtre, et la médiane peut aussi lever le filtre sans nouvelle règle. Elle
évite d'inventer un second critère de réactivation et de modifier
`decidePairSpread`.

**Conséquences.**

- La réactivation est visible au **cycle suivant**, pas dans le cycle
  courant : la paire a déjà été sautée, et la rescanner dans le même cycle
  annulerait l'économie de la probe.
- Un sample de probe est soumis aux mêmes règles de fenêtre et
  d'ancienneté que les autres : s'il est trop vieux ou truncé, il ne
  réactive rien.
- Une probe réussie avec un `bps` **sous** le plancher ne réactive pas la
  paire par la voie rapide ; elle peut seulement contribuer à une
  réactivation par la médiane. Si la médiane reste sous le plancher, la
  paire reste filtrée.
- Si le sample de probe est éliminé par la déduplication du Store (même
  `at`, valeur plus basse), il ne réactive rien. En `enforce`, un scan et
  une probe de la même clé ne peuvent pas coexister dans le même cycle
  (D5), donc ce cas est une défense, pas un mode normal.
- Si le commit échoue, le sample n'est pas persisté et ne réactive rien au
  cycle suivant (D15).
- Aucun seuil supplémentaire, aucune marge et aucun compteur de
  réactivation ne sont introduits.

**Hypothèses.** `bestNetProfitBps` retourne un `bigint` exact et
`pair.minProfitBps` est un entier valide ; le plancher n'est pas modifié
par l'adaptive (condition de réexamen n° 4 de l'ADR 0006).

### D5 — Exclusion structurelle scan / probe

**Décision.** Le cycle maintient deux ensembles de clés
canoniques :

- `scannedKeys` : clés pour lesquelles `scanPair` a été **appelé**, y
  compris si l'appel a levé ou retourné autre chose qu'un tableau ;
- `probedKeys` : clés pour lesquelles le wrapper de probe a été **entré**
  (probe commencée), y compris si `scanPair` a levé pendant la probe.

`scannedKeys` doit être renseigné **avant** l'appel à `scanPair`, dont
l'invocation actuelle commence à `bot/index.js:448` ; l'implémentation
insère `scannedKeys.add(pairKey)` juste avant cette ligne. `probedKeys` est
renseigné à l'entrée du wrapper, **avant** l'appel à `scanPair`. La
sélection des candidats **marque** comme non éligible toute clé de
`scannedKeys ∪ probedKeys` sans la retirer de la liste : elle est examinée
et résolue, puis dépassée (D3). Juste avant d'entrer dans le wrapper,
l'intégrateur vérifie à nouveau que la clé n'est ni dans `scannedKeys` ni
dans `probedKeys`. L'invariant du cycle est :

```
scannedKeys ∩ probedKeys = ∅
```

**Justification.** Il répond à M2. Sans exclusion, une paire peut être
scannée puis sondée (ou l'inverse) dans le même cycle : coût RPC doublé,
deux observations au même `at`, et risque de conflit dans le Store entre
un sample et un attempt non-`success` pour la même clé
(`bot/pairSpreadStore.js:791-801`). L'exclusion rend le doublon impossible
par construction, même si la liste de candidats est calculée avant les
décisions.

**Conséquences.**

- Si une clé est à la fois scannée et candidate, le **scan gagne** : la
  probe est abandonnée. Le scan est l'observation primaire ; il produit
  déjà un sample et des compteurs.
- `scannedKeys` est renseigné **avant** l'appel à `scanPair`, pas après :
  un scan qui lève reste un scan et ne doit pas être sondé ensuite.
- Une paire filtrée n'appelle jamais `scanPair` ; elle n'entre donc pas
  dans `scannedKeys` et peut être sondée.
- `probedKeys` est renseigné à l'entrée du wrapper : une probe qui lève
  reste une probe commencée, elle ne doit pas être retentée dans le même
  cycle.
- Une clé sélectionnée mais jamais entrée dans le wrapper n'est pas dans
  `probedKeys` ; elle n'a pas été tentée, n'est pas résolue et reste devant
  le curseur (D3).
- La déduplication de D3 s'applique aussi aux candidats : une clé ne peut
  pas être sondée deux fois dans un cycle.
- Les deux ensembles sont locaux au cycle ; ils ne sont ni persistés ni
  conservés entre deux cycles.

**Hypothèses.** Une clé identifie une route unique ; deux entrées de
configuration de même clé sont un doublon à corriger, pas deux routes
distinctes.

### D6 — Cadence : un scheduler par cycle, pas de timer externe

**Décision.** Le scheduler de probes est appelé **une seule fois
par cycle**, après la boucle principale et avant le commit d'état. Le
scheduler ne crée ni `setInterval`, ni `setTimeout`, ni aucun timer dédié
aux probes ; le `setTimeout` de cycle de `run.js` reste inchangé et ne
planifie pas les probes. La cadence est exprimée en **millisecondes**,
jamais en nombre de cycles. Trois horloges d'événement et d'ordonnancement
sont distinguées : `pairSpreadNow` horodate les observations (D11) et sert
à l'éligibilité par paire (D3) ; `probeNow` est l'horloge de l'enveloppe —
suspension et throttle global —, capturée une fois au début de la phase de
probe ; `lastGlobalProbeAt` reçoit cette valeur au démarrage de la première
probe du batch (D7), et non l'heure réelle de cette entrée. `probeNow` n'est
jamais persisté. L'échéance de suspension `suspendedUntil` (D15) est une
quatrième valeur temporelle, calculée avec `Date.now()` au moment de l'échec
du commit : ce n'est ni un horodatage d'événement ni une valeur persistée.

**Propriétaire et durée de vie du runtime de probes.** `bot/index.js`
possède un objet de runtime de probes, créé une fois au chargement du
module :

```
{
  lastGlobalProbeAt: null,
  writeFailures: 0,
  suspendedUntil: 0,
  pendingAttempts: new Map(), // Map<key, { key, at, outcome, source, reason? }>
  cursorKey: null
}
```

Cet objet survit aux appels successifs de `main()` dans le même processus
(`run.js`) et il est perdu au redémarrage. Il n'est **pas** persisté dans le
Store. Les tests injectent un objet frais via `main({ probeRuntime })` (ou
un helper équivalent) pour éviter les fuites d'état entre cas.

`pendingAttempts` conserve des attempts complets (pas seulement un `at`)
pour pouvoir les ré-émettre lors d'un commit ultérieur (D15). `cursorKey`
est le curseur de fairness (D3) : il est en mémoire et repart à `null` au
redémarrage.

`probeNow` est capturé une fois avec `Date.now()` au début de la phase de
probe, après la boucle principale. Il sert d'horloge à l'enveloppe
(suspension, throttle global) et à la valeur écrite dans
`lastGlobalProbeAt`. Il ne sert **pas** à l'éligibilité par paire, qui
utilise `pairSpreadNow` pour rester sur la même timeline que les `at`
persistés (D3, D11). Il n'est jamais utilisé comme `at` d'un sample ou d'un
attempt.

`lastGlobalProbeAt` est initialisé à `null` au chargement du module. Il est
mis à jour avec la valeur de `probeNow` capturée au début de la phase, au
moment où la **première probe du batch est commencée** (entrée dans le
wrapper, D3), pas à la sélection. Ce n'est pas l'heure réelle de cette
entrée : la valeur écrite est antérieure ou égale à cette heure. Il n'est
pas mis à jour si le batch est vide, si le throttle global bloque, si
toutes les clés sont exclues par D5, ou si toutes les probes sont annulées
avant le premier appel. Il est mis à jour même si toutes les probes
échouent. Il n'est jamais utilisé comme `at` d'un sample ou d'un attempt.

**Pourquoi `probeNow` pour le throttle global ?** `pairSpreadNow` est fixé
au début du cycle. Une boucle de scan longue peut retarder le batch de
plusieurs minutes ; utiliser `pairSpreadNow` pour `lastGlobalProbeAt`
ferait croire que le batch a démarré plus tôt et autoriserait le batch
suivant trop tôt. `probeNow` est capturé au début de la phase de probe,
avant la sélection et avant la première probe ; il mesure l'intervalle
entre deux **valeurs de `probeNow`** de phases de probe, pas l'intervalle
réel entre deux entrées dans le wrapper. La borne sur les démarrages réels
est plus faible et est explicitée en D7
(`b_{i+1} - b_i >= G - (b_i - g_i)`).

**Pourquoi `pairSpreadNow` pour l'éligibilité par paire ?** L'intervalle
par paire doit être mesuré entre les `at` persistés, pas entre les instants
réels des probes. Si l'éligibilité utilisait `probeNow`, un cycle dont la
boucle de scan est longue pourrait autoriser une probe d'une paire déjà
observée alors que `pairSpreadNow - lastAt < intervalMs` : le nouvel
attempt, horodaté `pairSpreadNow`, serait trop proche du précédent sur la
timeline du Store.
Le scheduler perdrait alors la borne `R_pair >= intervalMs` (D7) et le
calcul de `slots_max` ne serait plus valide. L'éligibilité utilise donc
`pairSpreadNow`, la même horloge que les `at`.

**Justification.** Un timer externe créerait un second cycle de vie,
pourrait chevaucher la boucle principale et serait impossible à arrêter
proprement dans `scan.yml`, qui est un processus éphémère. Un intervalle en
millisecondes est indépendant de `pollIntervalMs` (15 s par défaut dans
`run.js`) et du cron `*/5 * * * *` de `scan.yml` : changer la cadence du
cycle ne change pas la valeur configurée de l'intervalle, mais peut réduire
la cadence effective des batchs si les cycles deviennent plus longs que `G`
(D7).

**Conséquences.**

- La période effective par paire n'a pas de formule fermée. Le terme
  `ceil(N/M) × globalIntervalMs` n'est qu'une **estimation nominale** sous
  hypothèses (tous les candidats éligibles, `M` probes par batch, batchs
  espacés nominalement de `G`) ; ce n'est ni une borne supérieure ni une
  borne inférieure. La période réelle dépend de `N_candidates(t)`, des
  échecs, des suspensions et de la durée des cycles (D7).
- La période d'un cycle n'est pas `pollIntervalMs` : `run.js` attend la fin
  de `main()` puis applique `setTimeout(pollIntervalMs)`
  (`bot/run.js:103-127`). La période réelle est
  `D_i + pollIntervalMs + surcoût`, où `D_i` est la durée réelle de `main()`
  et n'a **aucune borne supérieure** dans le code. Une probe allonge `D_i`,
  donc retarde le cycle suivant et espace les batchs : la cadence est
  endogène.
- En l'absence de recul d'horloge, `probeNow >= pairSpreadNow` ; l'écart
  mesure la durée de la boucle principale. Un `probeNow` très postérieur ne
  change ni l'`at` des samples ou attempts, ni l'éligibilité par paire ; il
  n'affecte que le throttle global et la suspension.
- Avec `run.js`, les cycles ne se chevauchent pas : `run.js` attend la fin
  du cycle avant de planifier le suivant (`bot/run.js:111-127`). Il n'y a
  donc pas de probe concurrente d'un scan, et `lastGlobalProbeAt` survit
  d'un cycle à l'autre.
- Avec `scan.yml`, chaque exécution est un processus neuf :
  `lastGlobalProbeAt` repart à `null`, et le scheduler n'est appelé qu'une
  fois par processus. Le throttle global ne peut donc pas espacer les
  exécutions ; le cron est la seule borne inter-processus.
- Le Store `logs/pair_spreads.json` n'est **pas** persisté par `scan.yml` :
  seul `logs/scans.jsonl` est uploadé (`.github/workflows/scan.yml:55-63`).
  L'intervalle par paire et la rotation ne survivent donc pas d'une
  exécution à l'autre. **Les probes ne doivent pas être activées dans
  `scan.yml` tant que le Store n'est pas persisté et restauré.**
- `scan.yml` a `timeout-minutes: 15` et
  `concurrency.cancel-in-progress: true` (`.github/workflows/scan.yml:17-27`) :
  un run long peut être annulé, et un nouveau run annule le précédent. Les
  probes allongent le cycle ; elles ne doivent pas être activées dans ce
  workflow avant une mesure de la durée et une persistance du Store.
- **Activation initiale dans `run.js`, pas dans `scan.yml`.** `run.js` est
  le seul environnement où le Store est persistant, où `lastGlobalProbeAt`
  survit entre cycles, où les cycles ne se chevauchent pas et où aucune
  limite de 15 min ne coupe le cycle. C'est donc le seul endroit où le
  mécanisme complet (intervalle par paire, intervalle global, rotation,
  backoff) peut être validé. `scan.yml` est un processus éphémère de
  monitoring `DRY_RUN=true` ; l'activer d'abord testerait un mode dégradé
  (Store vide à chaque run, throttle global inerte) et pourrait produire
  des mesures trompeuses. Après validation dans `run.js`, l'activation dans
  `scan.yml` exige un changement de workflow pour persister/restaurer
  `pair_spreads.json` (artifact ou cache) et une vérification de la durée
  sous 15 min ; ce changement est hors périmètre de cet ADR.
- Aucun compteur de cycles n'est utilisé : un redémarrage ne décale pas la
  cadence par paire persistée ; le throttle global et le curseur, eux,
  repartent à zéro (`lastGlobalProbeAt = null`, `cursorKey = null`).

**Hypothèses.** `main()` est le seul point d'entrée d'un cycle ; `run.js`
garantit l'absence de chevauchement ; `scan.yml` vise un seul processus à
la fois via `concurrency`, mais l'annulation n'est pas instantanée et un
chevauchement bref reste possible (section 9.1).

### D7 — Budget : limite par cycle, intervalle par paire, intervalle global

**Décision.** Trois réglages, dont les valeurs par défaut
désactivent les probes :

1. **`maxPerCycle`** : nombre maximal de clés **sélectionnées** pour probe
   par appel du scheduler (probes tentées au sens de la sélection). Défaut
   `1`, minimum `1`, maximum **`10`**. Toute valeur supérieure à `10` est
   rejetée. C'est un plafond dur, pas une garantie de succès : un batch
   sélectionné de `M` clés peut démarrer moins de probes (exclusion D5,
   annulation) et produire zéro sample.
2. **`intervalMs`** : intervalle minimal entre deux probes d'une **même
   paire**. Défaut `0`, qui désactive complètement les probes. Valeur
   d'activation recommandée : `3600000` (1 h).
3. **`globalIntervalMs`** : intervalle minimal entre deux **batchs
   démarrés** — un batch est démarré lorsque sa première probe est
   commencée (entrée dans le wrapper, D3) —, tous candidats confondus.
   Défaut `0` (aucun throttle, probes désactivées). Valeur d'activation
   recommandée : `300000` (5 min). Si `intervalMs > 0`, la validation exige
   `globalIntervalMs > 0`. Un batch sélectionné dont aucune probe ne démarre
   (toutes les clés exclues par D5 ou annulées avant le wrapper) ne met pas
   à jour `lastGlobalProbeAt` et ne compte pas comme batch démarré.

**Sémantique de `0`.**

- `intervalMs = 0` désactive complètement les probes ; `maxPerCycle` et
  `globalIntervalMs` sont inertes.
- `globalIntervalMs = 0` signifie « pas de throttle global » au niveau du
  scheduler pur. Au niveau de la configuration, cette valeur n'est acceptée
  que si `intervalMs = 0` (probes désactivées). Elle est refusée si
  `intervalMs > 0`, pour éviter une rafale non bornée.
- Cette séparation permet de tester le scheduler pur avec
  `globalIntervalMs = 0`, tout en interdisant une activation sans borne
  globale.

**Algorithme du scheduler.** Le scheduler est le contrat canonique de D3 ;
l'algorithme ci-dessous explicite l'ordre des étapes et les horloges. La
validation des types, sentinelles et bornes (D3) est effectuée **avant**
l'étape 0 : un paramètre invalide est rejeté même si le préambule aurait
retourné une sélection vide.

```
0. si probeNow < suspendedUntil -> { selected: [], nextCursorKey: cursorKey }   (D15)
1. si intervalMs === 0 -> { selected: [], nextCursorKey: cursorKey }
2. si globalIntervalMs > 0
      et lastGlobalProbeAt !== null
      et probeNow - lastGlobalProbeAt < globalIntervalMs
        -> { selected: [], nextCursorKey: cursorKey }
3. filtrer les candidats dont la clé n'est pas une chaîne non vide
4. dédupliquer par clé, en conservant la première occurrence
5. pour chaque clé, calculer lastAt et marquer l'éligibilité sans retirer
   la clé :
     lastAt = max(history.get(key) ?? -1, pendingAttempts.get(key)?.at ?? -1)
     si lastAt == -1 : éligible sans filtre d'intervalle ni contrôle de futur
     sinon : non éligible si lastAt > pairSpreadNow
             non éligible si pairSpreadNow - lastAt < intervalMs
     non éligible si key ∈ scannedKeys ∪ probedKeys
     éligible sinon
6. trier toutes les clés uniques par clé croissante
7. déterminer la clé de départ : si cursorKey est présent dans la liste,
   commencer à la clé suivante (wrap) ; sinon commencer à la première clé
8. parcourir circulairement une fois, sans répétition ;
   examiner chaque clé, y compris non éligible ou exclue D5 ;
   retenir au plus maxPerCycle clés éligibles, sans consommer de slot
   pour les autres ; s'arrêter dès maxPerCycle sélections ;
   retourner { selected, nextCursorKey: dernière clé examinée }
   (nextCursorKey = cursorKey si aucune clé candidate)
```

Le calcul d'éligibilité (étape 5) précède le parcours, mais il ne supprime
aucune clé : les clés non éligibles et exclues par D5 restent dans la liste
et sont examinées sans consommer de slot. Le throttle global (étape 2)
précède le parcours : il ne consomme aucun slot et ne met pas à jour
`lastGlobalProbeAt`. Les étapes 0, 1 et 2 retournent
`{ selected: [], nextCursorKey: cursorKey }` et ne modifient ni le curseur
ni `lastGlobalProbeAt`. Le parcours circulaire, la clé de départ et la
sémantique de `cursorKey` sont définis en D3 ; `nextCursorKey` est un
curseur de sélection, pas le curseur runtime.

Les étapes 0 et 2 utilisent `probeNow`, l'horloge réelle du processus.
L'étape 5 utilise `pairSpreadNow`, l'horloge des `at` persistés : c'est
elle qui garantit, tant que l'attempt précédent est visible (persisté ou
dans `pendingAttempts`), que deux attempts successifs d'une même paire sont
séparés d'au moins `intervalMs` sur la timeline du Store (D3, D11).

**Mise à jour de `lastGlobalProbeAt`.** Voir D6 : propriétaire
`bot/index.js`, initialisation `null`, durée de vie du processus. La valeur
écrite est la valeur de `probeNow` capturée au début de la phase de probe,
au moment où la première probe du batch est commencée (entrée dans le
wrapper) ; ce n'est **pas** l'heure réelle de cette entrée, mais une borne
antérieure. La mise à jour n'utilise pas `pairSpreadNow`, a lieu même si
toutes les probes échouent, et n'a jamais lieu si le batch est vide, si
toutes les clés sont exclues par D5 ou si toutes les probes sont annulées
avant le premier appel.

**Justification.** `maxPerCycle` seul ne borne pas la fréquence : avec
`run.js` à 15 s de délai de polling et `maxPerCycle = 1`, le scheduler peut
tenter jusqu'à 5 760 probes par jour ; avec `maxPerCycle = 10`, jusqu'à
57 600. Ce sont des **probes**, pas des requêtes RPC. L'intervalle par paire
borne la fréquence d'une paire, mais pas les rafales quand plusieurs paires
deviennent éligibles ensemble. L'intervalle global lisse les démarrages de
batchs et borne `B`, pas directement `Q`. Il répond à M3. La borne
`maxPerCycle <= 10` est une limite dure de sécurité, révisable par un futur
ADR après mesure ; elle n'est pas dérivée d'une mesure actuelle.

**Capacité, cadence et rotation : définitions séparées.**

La capacité ne se réduit pas à un nombre de probes par jour. Les grandeurs
suivantes sont distinctes :

| Grandeur | Définition | Connue au démarrage ? |
|---|---|---|
| `N_config` | `config.pairs.length`, borne supérieure du nombre de clés candidates | oui |
| `N_candidates(t)` | clés distinctes effectivement filtrées en `enforce` au cycle `t`, après déduplication et exclusions | non |
| `M` | `maxPerCycle`, plafond de clés sélectionnées par batch | oui |
| `B_sel` | batchs pour lesquels le scheduler a retourné une sélection non vide | non |
| `m_t` | probes réellement **commencées** dans le batch démarré `t`, `1 <= m_t <= M` | non |
| `B` | batchs **démarrés** : au moins une probe commencée (entrée dans le wrapper), c'est-à-dire le nombre de mises à jour de `lastGlobalProbeAt` ; `B <= B_sel` | non |
| `P` | probes commencées sur une période, `P = Σ m_t` sur les `B` batchs démarrés | non |
| `Q` | requêtes RPC émises par les probes | non ; dépend de `S` et des résultats |
| `P_c(t)` | période entre deux débuts de cycle | non ; dépend de `D_i` |
| `R_pair(k)` | écart entre les `at` de deux attempts de probe consécutifs d'une même paire `k` | non |

**Période réelle des cycles et cadence des batchs.**

`bot/run.js` exécute `main()` puis attend `pollIntervalMs` avant le cycle
suivant (`bot/run.js:103-127`). En notant `s_i` le début du cycle `i`, `D_i`
la durée réelle de `main()` et `ε_i` le surcoût de planification :

```
s_{i+1} = s_i + D_i + pollIntervalMs + ε_i
```

`D_i` inclut la boucle de scan, la phase de probe, le commit et les logs.
Aucune borne supérieure de `D_i` n'existe dans le code : elle dépend du
nombre de paires, de `tradeSizes.length`, de la latence RPC, des timeouts et
du nombre de probes. Une probe allonge `D_i`, donc retarde le cycle suivant,
donc espace les batchs. La cadence est endogène.

Un batch ne peut démarrer qu'au début de la phase de probe, après la boucle
principale. Dans ce paragraphe, « démarrer » signifie **commencer au moins
une probe** (entrée dans le wrapper), pas « retourner une sélection non
vide » : un batch sélectionné dont toutes les clés sont exclues par D5 ou
annulées avant le wrapper n'est pas un batch démarré et n'appartient pas à
`B`. Soit `g_i` la valeur de `probeNow` capturée au début de la phase de
probe du batch démarré `i` — c'est cette valeur qui est écrite dans
`lastGlobalProbeAt` —, et `b_i` l'heure réelle de la première entrée dans
le wrapper. On a `b_i >= g_i`. Le throttle garantit, quand le batch `i` a
mis à jour `lastGlobalProbeAt` :

```
g_{i+1} - g_i >= G
```

Il ne garantit **pas** `b_{i+1} - b_i >= G`. La borne réelle sur les
démarrages est :

```
b_{i+1} - b_i >= G - (b_i - g_i)
```

Cette borne peut être plus faible que `G` lorsque la première probe du
batch `i` démarre tard dans la phase ; elle est triviale si
`b_i - g_i >= G`. Le second terme de la cadence n'est pas une constante :
il contient la fin des probes, le commit, `pollIntervalMs`, et la partie du
cycle suivant qui précède la phase de probe. Il n'existe pas de `T_max`
fixe dans le code. L'expression `T_batch = ceil(G / T_max) × T_max` ne
serait valide que si les cycles étaient des créneaux fixes de durée `T_max`
et si un batch pouvait démarrer à chaque frontière de créneau ; ce n'est
pas le cas. Elle n'est pas retenue comme borne de la cadence des batchs.
`B_sel` peut être plus grand que `B` : les batchs sélectionnés mais non
démarrés ne sont pas throttlés par `lastGlobalProbeAt`, mais ne produisent
ni probe ni requête RPC.

Conséquences :

- `G` est un minimum entre deux **valeurs de `probeNow`** de phases de
  probe de batchs démarrés, pas une période et pas un minimum entre deux
  entrées réelles dans le wrapper. Le throttle se mesure depuis `g_i`, pas
  depuis `b_i` : la partie de `D_i` antérieure au batch (boucle de scan) ne
  compte pas dans l'écart entre deux `g_i`.
- Si le délai réel entre `g_i` et la phase de probe du cycle suivant est
  inférieur à `G`, le batch suivant attend `g_i + G` ; sinon, il démarre dès
  la phase de probe du cycle suivant. La cadence des `g_i` est donc
  `max(G, délai réel entre deux phases de probe)`, sans formule fermée.
- Un `D_i` long ne raccourcit pas l'écart entre deux `g_i` : le throttle se
  mesure depuis `g_i`, donc `g_{i+1} >= g_i + G` tant que le batch précédent
  a mis à jour `lastGlobalProbeAt`. La partie de `D_i` antérieure au batch
  ne compte pas. En revanche, un `D_i` long peut augmenter `b_i - g_i` et
  affaiblir la borne sur les démarrages réels ; il réduit aussi le nombre de
  cycles, donc le nombre de batchs par jour, et allonge la rotation réelle.
  Il n'existe pas de garantie `b_{i+1} >= b_i + G`.
- Un `D_i` court n'impose pas un batch toutes les `G` : si la phase de
  probe du cycle suivant arrive après `g_i + G`, le batch démarre dès cette
  phase ; sinon, il attend `g_i + G`.
- Dans `scan.yml`, `s_i` dépend du cron, de la file GitHub, du timeout de
  15 min et de `cancel-in-progress` ; il n'y a pas de période fixe.

**Période par paire : borne inférieure et absence de borne supérieure.**

Pour une paire `k`, `R_pair(k)` est l'écart entre les `at` de deux
attempts de probe consécutifs pour cette paire.

- **Borne inférieure sur la timeline des `at`.** Tant que l'attempt
  précédent est visible — persisté dans le Store ou conservé dans
  `pendingAttempts` du processus courant —, `R_pair(k) >= intervalMs` : le
  scheduler exclut toute clé déjà observée dont
  `pairSpreadNow - lastAt < intervalMs`, et une clé jamais sondée
  (`lastAt = -1`) est éligible sans appliquer ce filtre. L'attempt de la
  probe retenue est horodaté `pairSpreadNow`. L'écart entre les deux `at`
  est donc au moins `intervalMs`, même si `probeNow` varie beaucoup d'un
  cycle à l'autre. `G` borne l'écart entre deux démarrages de
  batchs, pas l'écart entre deux `at` : le throttle peut retarder un batch
  sans décaler le `pairSpreadNow` de son cycle, donc deux cycles consécutifs
  peuvent produire des `at` séparés de moins de `G`. La seule borne
  inférieure sur la timeline des `at` est `intervalMs`. Un attempt non
  persisté et perdu au redémarrage (D15) échappe à cette borne : il n'a
  alors laissé aucun sample dans le Store.
- **Borne conditionnelle avec curseur.** Si `N` candidats sont tous
  éligibles à chaque batch, si `M <= N` et si les batchs sont successifs, le
  curseur sélectionne chaque clé au moins une fois dans toute fenêtre de
  `ceil(N/M)` batchs consécutifs ; l'écart entre deux sélections d'une même
  clé est compris entre `floor(N/M)` et `ceil(N/M)` intervalles de batch. Ce
  résultat suppose que le curseur avance et que les batchs ont lieu ; il ne
  donne aucune borne en temps absolu.
- **Borne supérieure.** Aucune garantie. Les échecs, les `empty`, les
  suspensions, les redémarrages, les changements de `N_candidates` et les
  cycles longs peuvent augmenter `R_pair(k)` sans limite démontrable. Le
  curseur garantit l'absence de famine tant que les batchs ont lieu et que
  le candidat reste éligible, pas une période maximale.

Le terme `ceil(N/M) × G` est donc une **estimation nominale** de la
rotation, pas une borne supérieure. Il ne permet pas de démontrer une
impossibilité.

**Fenêtre temporelle et slots par paire.**

`selectWindowSamples` (`bot/pairSpread.js:225-258`) conserve les
échantillons dont `at >= pairSpreadNow - maxAgeMs` et
`at <= pairSpreadNow` ; les `at` futurs sont exclus. La fenêtre est donc
l'intervalle **fermé** `[pairSpreadNow - maxAgeMs, pairSpreadNow]`. Un
échantillon à exactement `pairSpreadNow - maxAgeMs` compte, et un
échantillon à `pairSpreadNow` compte. Le scheduler utilise `pairSpreadNow`
pour l'éligibilité et, pour une paire déjà observée, accepte
`pairSpreadNow - lastAt >= intervalMs` (égalité autorisée) ; une clé
jamais sondée (`lastAt = -1`) est éligible sans appliquer ce filtre (D3).
C'est la même horloge que les `at` écrits par les
probes, donc le décompte des slots est exact sur la timeline persistée.

Si une paire n'est alimentée que par des samples de probe et que deux
samples de probe **persistés** sont séparés d'au moins `intervalMs`, le
nombre maximal de samples de probe dans une fenêtre fermée de largeur
`maxAgeMs` est :

```
slots_max = floor(maxAgeMs / intervalMs) + 1
```

L'espacement des samples persistés découle directement de l'éligibilité :
lorsqu'un sample de probe est dans la fenêtre, il est aussi dans
l'historique fourni au scheduler (D8), donc `lastAt >= at_du_sample`. Le
prochain probe exige `pairSpreadNow - lastAt >= intervalMs`, donc son `at`
est au moins `intervalMs` après ce sample. Cette propriété survit au
redémarrage, car les samples sont persistés ; elle ne dépend pas de
`probeNow`. Un sample dont l'écriture a échoué n'est pas dans le Store et ne
compte pas dans la fenêtre.

La formule compte le nombre maximal de points d'une grille de pas
`intervalMs`, ancrée à une extrémité, dans l'intervalle **fermé** de largeur
`maxAgeMs`. Le `+1` compte **toujours** le point de départ
(`now - maxAgeMs`), jamais conditionnellement le point d'arrivée. Le point
d'arrivée `now` n'est un slot supplémentaire que si `maxAgeMs` est un
multiple exact de `intervalMs`. Exemple non multiple : `maxAgeMs = 90`,
`intervalMs = 60` donne `floor(90/60) + 1 = 2` points (`now - 90` et
`now - 30`), sans point à `now`. Exemple multiple : `maxAgeMs = 120`,
`intervalMs = 60` donne `floor(120/60) + 1 = 3` points (`now - 120`,
`now - 60`, `now`). Avec une fenêtre semi-ouverte
`[now - maxAgeMs, now)`, le point à `now` serait exclu et le compte serait
différent ; ce n'est pas la convention du code. La formule n'est évaluée
que si `intervalMs > 0`.

Si `slots_max < minSamples`, alors une paire filtrée ne peut pas recevoir
`minSamples` échantillons de probe dans la fenêtre, même avec 100 % de
succès et un ordonnancement parfait. C'est équivalent à
`(minSamples - 1) × intervalMs > maxAgeMs`. C'est la **seule impossibilité
démontrable** à partir des réglages : elle ne dépend ni de `N`, ni de `M`,
ni de `G`, ni de la rotation. Elle ne prouve pas qu'une paire ne peut jamais
être réactivée : une seule probe au-dessus du plancher peut la réactiver par
`LAST_AT_OR_ABOVE_FLOOR`. Elle prouve seulement que les probes ne peuvent
pas maintenir `minSamples` échantillons dans la fenêtre.

La validation D12 impose `intervalMs <= maxAgeMs / minSamples`, donc
`maxAgeMs / intervalMs >= minSamples`, donc `slots_max >= minSamples`. La
condition d'impossibilité est déjà exclue par la validation. Aucun
avertissement `PROBE_CAPACITY_IMPOSSIBLE` n'est émis : il serait redondant
avec la validation D12, qui exclut déjà cette condition. Si la borne D12
est un jour relâchée, cette condition doit devenir une erreur dure (ou un
avertissement `PROBE_CAPACITY_INSUFFICIENT`), pas une heuristique.

**Capacité nominale et avertissements.**

Pour un avertissement au démarrage, `bot/config.js` reçoit
`pairCount = config.pairs.length` via `validateScannerConfig` (paramètre
optionnel ; absent dans certains tests unitaires), puis le transmet à
`validatePairSpreadSettings`. `pairCount` est soit une **sentinelle
admise** (`undefined` ou `null`), soit un **entier sûr `>= 0`** (`0`
compris) ; lorsque les probes sont actives, `undefined`, `null` et `0`
déclenchent `PROBE_CAPACITY_INDETERMINATE` (D12) ; une valeur fournie qui
n'est ni une sentinelle admise ni un entier sûr `>= 0` (négative,
fractionnaire, `NaN`, `Infinity`, non numérique ou supérieure à
`Number.MAX_SAFE_INTEGER`) est une **erreur de validation**, jamais un
silence ni une estimation. Lorsque `pairCount` est un entier sûr strictement
positif, il calcule une fois, avec `N = N_config = pairCount` comme borne
supérieure du nombre de candidats, `M`, `G`, `intervalMs`, `minSamples` et
`maxAgeMs` :

```
R_nom = max(intervalMs, ceil(N / M) × G)
```

Hypothèses explicites :

- `N_config` paires sont candidates à chaque cycle ; c'est une borne
  supérieure, `N_candidates(t) <= N_config` ;
- chaque batch démarré tente exactement `M` probes ; en réalité
  `1 <= m_t <= M` puisqu'un batch démarré compte au moins une probe
  commencée ; un batch sélectionné mais non démarré ne contribue pas à
  `B` ;
- les valeurs de `probeNow` des batchs démarrés sont espacées nominalement
  de `G`, soit un batch par intervalle `G` en nominal ; en réalité l'écart
  entre ces valeurs est `>= G` et peut être beaucoup plus grand à cause de
  `D_i`, des échecs et des suspensions ; les démarrages réels peuvent être
  plus rapprochés que `G` (D7) ;
- chaque probe réussit et produit un sample ; le taux de succès réel est
  `p < 1`, et les `empty`/`failure` consomment un slot sans sample ;
- aucun redémarrage, aucune suspension, aucun chevauchement, aucune
  exclusion scan/probe ;
- `intervalMs` est la seule contrainte par paire.

`R_nom` n'est ni une borne supérieure ni une borne inférieure de la rotation
réelle : c'est une **estimation nominale** de planification. Si
`N_candidates << N_config`, la rotation réelle peut être plus rapide ; si
`D_i` est grand, si `p < 1`, si des suspensions surviennent, si des batchs
sont annulés ou si des cycles sont longs, elle peut être plus lente. Les
suspensions (`suspendedUntil`), les annulations et la durée réelle des
cycles peuvent dégrader la cadence sans qu'aucune formule ne le capture.
La capacité nominale n'est **pas** une garantie de cadence : `B` peut être
nul, `B_sel` peut être non nul sans qu'aucune probe ne démarre, et l'écart
entre deux batchs démarrés peut dépasser `G`.
L'absence d'avertissement `PROBE_CAPACITY_MARGIN` ne prouve pas que
`minSamples` sera atteint. Une mesure runtime est nécessaire avant de
considérer l'activation en `enforce` comme validée ; aucun seuil numérique
n'est fixé par cet ADR.

Avertissements :

- `PROBE_CAPACITY_MARGIN` : `minSamples × R_nom > maxAgeMs`. Message : la
  marge nominale est dépassée ; la rotation peut ne pas fournir
  `minSamples` échantillons dans la fenêtre. C'est un **indicateur
  nominal**, pas une preuve ; vérifier `N_candidates` réel, la durée des
  cycles, le taux de succès et les suspensions.
- `PROBE_CAPACITY_INDETERMINATE` : `pairCount` est `undefined`, `null` ou
  `0` alors que les probes sont actives (`intervalMs > 0`, mode `enforce`).
  Message : la capacité ne peut pas être estimée au démarrage ; fournir
  `pairCount` ou mesurer la rotation. Aucun `PROBE_CAPACITY_IMPOSSIBLE`
  n'est émis. Une valeur fournie qui n'est ni une sentinelle admise ni un
  entier sûr `>= 0` (y compris un type non numérique) est une erreur de
  validation (D12), pas un avertissement.
- Ces deux avertissements sont des **indicateurs nominaux** : ils ne
  constituent ni une preuve de capacité suffisante, ni une preuve
  d'impossibilité.
- Si `pairCount` est fourni et strictement positif, et que
  `minSamples × R_nom <= maxAgeMs`, aucun avertissement de capacité n'est
  émis ; cela ne garantit pas la capacité réelle.
- Si `intervalMs = 0` ou si le mode est `off`/`shadow`, aucun avertissement
  de capacité n'est émis.
- Les avertissements sont émis **une fois par processus, au démarrage**,
  pas à chaque cycle.
- Une mesure runtime (nombre réel de candidats, durée des cycles, taux de
  succès, samples observés par paire dans la fenêtre) est requise avant de
  considérer l'activation en `enforce` comme validée. Aucun seuil numérique
  n'est fixé ici ; les seuils seront définis après mesure.
- Si le produit `ceil(N/M) × G` dépasse `Number.MAX_SAFE_INTEGER`, émettre
  `PROBE_CAPACITY_INDETERMINATE` plutôt qu'un calcul faux.

**Coût RPC : trois grandeurs distinctes.**

`B`, `B_sel`, `P` et `Q` ne sont pas interchangeables :

- `B` batchs démarrés : un batch compte dans `B` lorsqu'au moins une probe
  est commencée (entrée dans le wrapper) ; c'est le nombre de mises à jour
  de `lastGlobalProbeAt`. Un batch sélectionné mais entièrement exclu par
  D5 ou annulé avant le wrapper compte dans `B_sel`, pas dans `B`. `B_sel`
  peut être plus grand ; il ne produit ni probe ni requête RPC.
  `B` est borné par la cadence des cycles et, quand il est actif, par
  `globalIntervalMs` ; `maxPerCycle` borne `P`, pas `B`.
- `P` probes commencées : `P = Σ m_t` sur les `B` batchs démarrés, avec
  `1 <= m_t <= M`. Une probe peut être `success`, `empty` ou `failure`.
- `Q` requêtes RPC : `Q = Σ q(probe)`, où `q` dépend de la paire et des
  résultats de quoting. `Q` n'est ni `P` ni `B`.

`M` borne `P` par batch, pas `Q`. Le throttle global borne `B` (au mieux,
avec les réserves de cadence ci-dessus), pas `Q` directement.

**Coût d'une probe dans le code actuel.**

`scanPair` (`bot/scanner.js:257-377`) exécute, pour chaque taille retenue :

- `quoteEntryDepth` : 2 quotes (taille pleine et taille/2) si
  `amountIn / 2 > 0` ;
- `scanTradeSize` : 1 quote sur la jambe retour, la quote d'entrée étant
  réutilisée, si la profondeur est dans la limite ;
- si la profondeur est dépassée : 2 quotes pour la taille qui dépasse, puis
  0 quote pour toutes les tailles supérieures (`DEPTH_EXCEEDED`) ;
- si une quote lève : la taille est marquée en erreur et la boucle continue ;
  le nombre de requêtes déjà dépensées dépend de l'endroit de l'échec ;
- si `pair.logSweep` **et** `interp.interpolated === true` **et** au moins
  3 tailles sans erreur : une re-quote interpolée via `scanTradeSize`, soit
  2 quotes supplémentaires (entrée + retour), car aucune quote d'entrée
  n'est réutilisée. La condition `interp.interpolated === true` est celle du
  code (`bot/scanner.js:334-347`) ; sans elle, aucune re-quote interpolée
  n'a lieu et les 2 quotes ne s'appliquent pas.

Dans le cas nominal « toutes les tailles dans la profondeur, pas
d'interpolation (`interp.interpolated !== true`) », `q = 3 × S`, où `S`
est le nombre de tailles. Avec interpolation
(`interp.interpolated === true`), `q = 3 × S + 2`. En cas de dépassement de
profondeur à la taille `k` (1-based), `q = 3 × (k - 1) + 2` pour les tailles
examinées, plus 0 pour les suivantes. Ces formules sont des modèles, pas une
mesure : les erreurs, les re-quotes et les cas `amountIn / 2 == 0` changent
`q`.

`S` n'a pas de borne supérieure explicite dans `bot/config.js` :
`pair.tradeSizes` doit être non vide, sans doublon, positif et sous le
plafond du profil (`bot/config.js:227-255`, `:272-279`), mais sa longueur
n'est pas plafonnée. `pair.logSweep.steps` est borné à 3–20
(`bot/config.js:206-208`). Une paire avec beaucoup de `tradeSizes` peut donc
rendre une probe arbitrairement coûteuse en requêtes ; le seul plafond
pratique est la taille du fichier de configuration et le timeout du
workflow. Ne pas inventer de coût fixe par probe.

`scanPair` peut appeler `provider.getBlockNumber()` s'il ne reçoit pas de
`blockTag` (`bot/scanner.js:266-269`). Une probe doit réutiliser le
`blockTag` du cycle (D2), donc ce coût est nul pour les probes. Les autres
appels du cycle (fee data, ETH/USD, chaîne, prime Aave) ne sont pas des
coûts de probe.

**Throttle.** Toutes les quotes de scan et de probe passent par le même
throttle de scanner (`getScannerThrottle`, `bot/scanner.js:19-27`),
sérialisé FIFO avec un intervalle minimal `THROTTLE_MIN_INTERVAL_MS`
(250 ms par défaut, `bot/config.js:604`). Le throttle espace les départs, il
ne borne ni la longueur de la file ni le nombre total de requêtes
(`bot/throttle.js:44-78`). Une probe de `q` requêtes dure donc au moins
environ `(q - 1) × 250 ms` plus la latence RPC et le temps des autres
quotes en file ; ce n'est pas un coût fixe et cela allonge `D_i`, donc
espace les batchs. Si `THROTTLE_MIN_INTERVAL_MS = 0`, l'espacement minimal
disparaît.

**Débit en probes, pas en requêtes.** Les chiffres suivants sont des
**bornes supérieures de probes**, pas des prévisions et pas des requêtes
RPC. Ils supposent que chaque probe réussit, que chaque probe produit un
sample, que les cycles sont plus courts que `G`, qu'aucune probe n'est
`empty`/`failure`/`UNPRICED`/`QUOTE_STALE`, et qu'aucun cycle n'est retardé
par le RPC. Le débit réel est inférieur.

- `run.js` (15 s de délai de polling), sans throttle global, `M`
  probes/batch : au plus `5760 × M` probes/jour si la durée de `main()`
  était nulle. `M = 1` → 5 760 ; `M = 10` → 57 600. Cette configuration
  n'est plus acceptée si `intervalMs > 0` (D12) ; elle ne sert qu'à
  illustrer le risque M3. En pratique, `D_i > 0` réduit ce nombre. `B_sel`
  peut dépasser le nombre de batchs démarrés, mais ne produit pas plus de
  probes.
- `run.js`, `globalIntervalMs = 300000` : au plus `288` batchs démarrés/jour
  si les batchs pouvaient démarrer exactement toutes les 5 min ;
  `288 × M` probes/jour. `M = 1` → 288 ; `M = 10` → 2 880. La durée réelle
  des cycles réduit ce nombre.
- `scan.yml` (cron 5 min) : au plus `288` batchs démarrés/jour, donc
  `288 × M` probes/jour. C'est une borne supérieure : GitHub peut retarder
  ou sauter un run, le timeout de 15 min peut couper un run, et
  `cancel-in-progress` peut annuler un run au profit du suivant. De plus, le
  Store n'étant pas persisté, l'intervalle par paire ne s'applique pas entre
  runs ; ce mode n'est pas retenu pour l'activation initiale (D6).

Le nombre de requêtes RPC est `Q = P × q_moyen`, avec `q_moyen` variable,
fonction de `tradeSizes.length` et des résultats de quoting. Comme
`tradeSizes.length` n'a pas de borne supérieure explicite, il n'existe pas
de borne `Q` dérivable des seuls réglages de probes.

**Exemples nominaux de rotation.** Avec le profil recommandé
(`intervalMs = 3600000`, `G = 300000`, `M = 1`) et `N = N_config` :

- `N = 20` : `ceil(20/1) × 5 min = 100 min` ;
  `R_nom = max(60, 100) = 100 min`.
- `N = 57` : `ceil(57/1) × 5 min = 285 min` ;
  `R_nom = max(60, 285) = 285 min`.
- `N = 10` : `50 min` ; `R_nom = max(60, 50) = 60 min` (l'intervalle par
  paire domine).

Avec `M = 10` :

- `N = 20` : `ceil(20/10) × 5 = 10 min` ;
  `R_nom = max(60, 10) = 60 min`.
- `N = 57` : `ceil(57/10) × 5 = 30 min` ;
  `R_nom = max(60, 30) = 60 min`.

Ces valeurs sont des **estimations nominales**. Elles supposent que les `N`
paires sont toutes candidates et que les batchs démarrés sont exactement
espacés de `G`. Elles ne prouvent ni une rotation maximale ni une capacité
suffisante, ni une cadence garantie.

Le plafond `P <= 288 × M` probes/jour (au plus 288 batchs démarrés) n'est
atteignable, lorsque `intervalMs > 0`, que si
`N × (floor(86400000 / intervalMs) + 1) >= 288 × M`. Avec `N = 57`,
`intervalMs = 1 h`, `M = 10` : `57 × 25 = 1425 < 2880`, donc l'intervalle
par paire borne à environ 1 425 probes/jour. Ces chiffres restent des bornes
de probes, pas de requêtes RPC.

**Nombre d'échantillons : aucune garantie.** Le nombre maximal théorique
d'échantillons par paire et par jour serait `floor(86400000 / R_pair) + 1`
si `R_pair` était constant, si chaque probe réussissait et si les
échantillons n'étaient pas évincés. `R_pair` n'est pas constant. La seule
borne dure sur les échantillons **issus des probes** est
`slots_max = floor(maxAgeMs / intervalMs) + 1` dans la fenêtre fermée. Pour
que `minSamples` échantillons puissent tenir dans `maxAgeMs`, il faut au
minimum que le premier et le dernier soient séparés de
`(minSamples - 1) × intervalMs <= maxAgeMs` ; c'est une condition
**nécessaire**, pas suffisante, et elle est déjà impliquée par la validation
D12. Un taux de succès `p < 1` réduit le nombre d'échantillons : un échec
consomme un slot de batch, produit un attempt et repousse la prochaine probe
de la paire de `intervalMs` (D8), sans produire de sample. Les erreurs de
quote,
les probes `empty`/`failure`, les `UNPRICED`, les `QUOTE_STALE`, les
latences RPC et les cycles longs réduisent encore le débit. Aucune formule
ne garantit `minSamples` sans connaître le taux de réussite réel et la
cadence réelle des batchs.

**Exemple de seuil d'alerte.** Avec les défauts du filtre
(`minSamples = 5`, `maxAgeMs = 24 h`), `G = 5 min`, `M = 1`,
`intervalMs = 1 h` : `R_nom = max(60, N × 5)`.
`PROBE_CAPACITY_MARGIN` est émis si `5 × R_nom > 1440 min`, soit
`R_nom > 288 min`, donc `N >= 58`. Avec `N = 57`, `R_nom = 285 min` et
`5 × 285 = 1425 <= 1440` : pas d'avertissement, mais aucune garantie. Avec
`M = 10`, le seuil devient `N >= 571`. Ces valeurs sont des **seuils
d'alerte nominaux**, pas des garanties.

**Conséquences.**

- `globalIntervalMs` ne protège que le processus courant. Dans `scan.yml`,
  chaque exécution repart avec `lastGlobalProbeAt = null` et
  `cursorKey = null` ; la borne inter-processus est le cron lui-même. Ce
  n'est pas un défaut : persister ces états exigerait un changement de
  schéma, hors périmètre (D14). Comme le Store n'est pas persisté non plus,
  les probes ne sont pas activées dans `scan.yml` avant un changement de
  workflow (D6).
- La validation D12 refuse un `globalIntervalMs` supérieur à
  `maxAgeMs / minSamples`. Cette borne est plus stricte que la condition
  nécessaire `maxAgeMs / (minSamples - 1)` : un intervalle compris entre les
  deux serait théoriquement compatible avec une paire seule, mais il est
  refusé par prudence pour conserver une marge d'un intervalle. Elle ne
  garantit pas la capacité réelle, qui dépend de `N_candidates`, de `D_i` et
  du taux de succès.
- Le budget dépend de `intervalMs`, `globalIntervalMs`, `maxPerCycle`, du
  nombre réel de candidats `N_candidates(t)`, de la durée réelle des cycles
  `D_i`, du taux de succès `p` et du coût par probe `q` (lui-même fonction de
  `tradeSizes.length`). Il ne dépend pas uniquement de `pollIntervalMs` ou du
  cron. Il n'existe pas de borne de requêtes RPC `Q` dérivable des seuls
  réglages de probes.
- La fairness n'est garantie que dans le processus courant : le curseur
  repart à `null` après un redémarrage ou entre deux runs `scan.yml`. Une
  clé basse et ancienne peut être favorisée au premier batch.
- Si une probe dure plus longtemps que l'intervalle global, le batch suivant
  peut être autorisé dès le cycle suivant : l'intervalle est mesuré depuis
  le démarrage du batch, pas depuis la fin de la probe.
- `maxPerCycle = 10` est un plafond, pas une cible ; la valeur recommandée
  à l'activation reste `1`.

**Hypothèses.** Le processus est unique ; aucun autre processus n'écrit
dans le Store pendant le cycle (limite connue n° 6 de l'ADR 0006).

### D8 — Reconstruction de l'historique depuis samples et attempts

**Décision.** Au début de chaque cycle,
`initProbeHistoryFromState` reconstruit l'horodatage **persisté** de
rotation de chaque paire avec :

```
lastAtPersisted(key) = max(samples[].at, attempts[].at)   // absent si aucun
```

Le scheduler applique ensuite l'overlay `pendingAttempts` (D3) :

```
lastAt(key) = max(
  lastAtPersisted(key) ?? -1,
  pendingAttempts.get(key)?.at ?? -1
)
```

Les paires qui n'ont que des `attempts` sont incluses. Les paires qui n'ont
que des `samples` sont incluses. Les paires sans aucun des deux sont omises
de l'historique persisté ; une clé dont `lastAtPersisted` est absente a
`lastAt = -1` après application de l'overlay (si elle n'est pas dans
`pendingAttempts`) et reste éligible comme jamais observée, sans appliquer
le filtre d'intervalle (D3). Le sentinel `-1` signifie « aucune
observation » ; les `at` de samples sont `>= 0` et ceux des attempts sont
`>= 1`. Les tableaux absents ou vides sont traités comme vides. L'état
d'entrée n'est jamais muté. `pendingAttempts` est fourni par l'appelant ;
une clé absente de la Map ne contribue pas au maximum. La clé de la Map
et `entry.key` doivent coïncider (D3) ; une incohérence est une erreur. L'overlay ne **crée jamais** de candidat : une
clé présente seulement dans `pendingAttempts` contribue à `lastAt` mais
n'est sélectionnée que si elle figure aussi dans `candidates` (D1, D3).

**Contenu de `pendingAttempts`.** Contrairement à un simple overlay
d'horodatage, `pendingAttempts` conserve des attempts **complets**
`{ key, at, outcome, source, reason? }`, identiques à ceux qui auraient été
commités (D15). C'est nécessaire pour les ré-émettre lors d'un commit
ultérieur : le Store exige `outcome` et `source`, et un `at` seul ne suffit
pas. Ces attempts ne fabriquent jamais de sample et ne remplacent jamais un
`at` persisté plus récent : `lastAt` prend le maximum. Un attempt en
attente dont `at > pairSpreadNow` reste dans l'overlay et n'est pas commité
au cycle courant ; il ne devient committable qu'à un cycle où
`pairSpreadNow >= at`. Les attempts en attente ne sont pas comptés comme
persistés : après un redémarrage, ils sont perdus.

**Horodatages persistés vs horodatages de scheduler.**

- **Persistés** : `samples[].at` et `attempts[].at` du Store v2. Ils
  survivent au redémarrage. `lastAtPersisted` est la seule source de
  l'historique de rotation après un redémarrage.
- **Scheduler en mémoire** : `lastGlobalProbeAt`, `writeFailures`,
  `suspendedUntil`, `pendingAttempts` et `cursorKey` (D3, D6, D15). Ils
  survivent aux cycles du même processus, pas au redémarrage. Ils ne sont
  jamais écrits dans le Store.
- **Historique par cycle** : une `Map<key, at>` reconstruite à partir des
  persistés, puis mise à jour par `recordProbeAttempt` après chaque probe ;
  l'overlay `pendingAttempts` est appliqué par le scheduler au moment de la
  sélection. Elle n'est pas conservée telle quelle entre deux cycles ; elle
  est recalculée.

**Reconstruction après redémarrage.** Le premier cycle après un
redémarrage :

1. `probeRuntime.lastGlobalProbeAt = null`, `cursorKey = null`,
   `pendingAttempts` vide, backoff à zéro ;
2. `loadPairSpreadState` lit le Store ; les samples et attempts persistés
   sont normalisés (ancienneté, futur, déduplication, plafond) ;
3. `initProbeHistoryFromState` calcule `lastAtPersisted` par clé avec le
   maximum des deux tableaux ; `pendingAttempts` est vide et n'est pas
   reconstruit depuis le Store ;
4. une paire dont le dernier attempt (scan ou probe) ou le dernier sample
   est récent est retardée par `intervalMs` ; une paire dont l'historique a
   été perdu (écriture échouée avant le redémarrage) peut être sondée plus
   tôt que prévu. C'est la limite de D15 : les attempts en attente ne
   survivent pas au redémarrage.

**Cas v1/v2.** Le Store v1 n'a pas d'`attempts` : les tableaux absents sont
traités comme vides, et l'historique repose sur les samples. Le Store v2
exige `attempts` (même vide) ; une paire v2 sans `attempts` est un schéma
invalide (ADR 0006 D1). Les samples n'ont pas de champ `source` ; un sample
de scan et un sample de probe sont indiscernables dans l'historique, ce qui
est voulu : seule la récence compte pour la rotation.

**Horodatages futurs.** Au chargement, le Store purge les samples futurs
(`bot/pairSpreadStore.js:190-200`) ; un attempt futur stocké (`:240-246`)
rend l'état non inscriptible (fail-open) selon l'ADR 0006 D1. Au commit, un
sample futur (`:605`) ou un attempt futur (`:630`) est refusé. La fonction
pure conserve néanmoins sa défense : un `at` futur injecté est conservé
dans l'historique, puis exclu de la sélection
(`bot/pairSpreadProbe.js:135`). Il ne peut ni faire sauter la file, ni
reculer.

**Justification.** Il répond à M1. Les attempts `probe` sont persistées
avec leur `at` ; si le redémarrage ne lit que les samples, une paire sondée
récemment mais sans nouveau sample (échec, `empty`, `UNPRICED`) paraît
« jamais sondée » et repasse en tête de rotation. Les autres paires sont
affamées. Les attempts seules, typiques d'une paire qui échoue ou ne price
pas, sont également invisibles.

**Conséquences.**

- Un échec de probe récent retarde correctement la prochaine probe de
  cette paire ; il ne la fait pas passer pour un succès.
- Un sample plus récent qu'un attempt gagne ; un attempt plus récent qu'un
  sample gagne aussi. Aucun des deux n'est converti en l'autre : un
  attempt n'est jamais fabriqué depuis un sample, et un sample n'est jamais
  fabriqué depuis un attempt (règle v2 de l'ADR 0006).
- Un attempt de scan récent retarde aussi une probe de la même clé. C'est
  conservateur et voulu : toute observation récente compte pour la
  rotation, même si elle provient du scan normal.
- `pendingAttempts` retarde la rotation en mémoire et sert à la ré-émission
  des attempts non écrits ; il ne réactive aucune paire et disparaît au
  redémarrage (D15).
- Le Store v1, qui n'a pas d'`attempts`, reste lisible : les tableaux
  absents sont traités comme vides.
- Si l'état est malformé, la fonction lève ; l'intégrateur désactive les
  probes pour le cycle, journalise `pair_spread_probe_history_error`
  (niveau warn) et continue le scan, sans faire échouer le cycle.
- Le plafond de 20 attempts par paire du Store peut faire disparaître un
  ancien attempt de scan ; c'est acceptable, car seul le plus récent
  compte pour la rotation.
- `recordProbeAttempt` retourne une nouvelle `Map` et ne recule jamais un
  timestamp : un `at` plus ancien ne remplace pas un `at` existant plus
  récent.

**Hypothèses.** Les `at` sont des entiers sûrs ; le Store garantit qu'ils
ne sont pas futurs par rapport au `now` de chargement, mais une dérive
d'horloge reste possible et est traitée par l'exclusion.

### D9 — Erreurs de probe et classification

**Décision.** Chaque probe est enveloppée dans un `try/catch`
local. Le résultat est classé exactement comme un scan vide, avec les
mêmes codes que la phase 2B :

| Situation | Attempt | Reason | Sample |
|---|---|---|---|
| `scanPair` lève, ou retourne autre chose qu'un tableau | `failure` | `SCAN_ERROR` | non |
| tableau vide | `empty` | `NO_RESULTS` | non |
| aucun résultat quoté exploitable | `empty` | `QUOTE_ERRORS` | non |
| résultat quoté sans `netProfitBps` calculable | `empty` | `UNPRICED` | non |
| la classification lève (résultat non classifiable) | `failure` | `SCAN_ERROR` | non |
| `bestNetProfitBps` retourne un `bigint` (y compris `0` ou négatif) | `success` | — | oui |

Une erreur de probe :

- n'incrémente ni `rpcErrors`, ni `pairErrors`, ni `scanned` ;
- ne modifie pas l'`exitCode` ; un cycle où toutes les paires sont filtrées
  reste un succès (`exitCode = 0`) même si toutes les probes échouent ;
- n'alimente ni le breaker RPC (`recordRpcCycle`), ni l'adaptive
  (`recordOutcome`) ;
- n'interrompt pas les autres probes ;
- émet un événement `pair_spread_probe` pour **chaque probe commencée**,
  avec la clé, le label, l'outcome, la raison et la durée, sans secret ni
  URL RPC. Les événements `success` et `empty` portent le niveau `debug` ;
  les événements `failure` portent le niveau `warn` ; le volume est borné
  par `maxPerCycle` par cycle. Le code actuel ne met pas en œuvre de
  filtrage par niveau : `bot/persist.js` gère `LOG_FORMAT`, pas `LOG_LEVEL`,
  et `bot/index.js` ne filtre pas les événements selon leur niveau.
  L'affichage dépend du consommateur et du mécanisme de journalisation
  utilisé.

**Ordre de traitement et invariant sample / attempt.** Pour chaque probe
commencée :

1. `scanPair` est appelé dans un `try/catch` local.
2. Le résultat est classifié selon le tableau ci-dessus.
3. Un sample n'est ajouté que si la classification produit `success` et un
   `bigint` exploitable. Si la classification lève, aucun sample n'est
   ajouté et l'attempt est enregistrée comme non-`success`
   (`failure`/`SCAN_ERROR`, faute de code dédié) : l'invariant du Store
   « sample + attempt non-`success` pour la même clé » est préservé.
4. L'attempt est enregistrée avec le `pairSpreadNow` du cycle, succès ou
   échec.
5. Le logging est effectué après la détermination du résultat. Il est
   **non bloquant** : une exception du logger ne transforme jamais une
   probe `success` en `failure`, ne retire pas le sample classifié et ne
   modifie pas l'attempt. Le sample et l'attempt sont ajoutés
   indépendamment du succès du logging ; l'erreur de logging est capturée
   localement et signalée sans interrompre la probe ni le cycle.

Une seule attempt finale est conservée par clé et par cycle
(`success > failure > empty`), comme pour les scans (`bot/index.js:90-99`).

**Justification.** Une probe est une optimisation best-effort. Elle ne
protège pas le capital et ne doit jamais transformer un cycle réussi en
échec, ni déclencher un breaker ou une adaptation sur une erreur qui n'a
pas affecté une décision d'exécution.

**Conséquences.**

- Un échec répété de probe est visible dans les logs et dans les attempts,
  mais n'arrête pas le bot ; il retarde seulement la prochaine probe de la
  paire (D8).
- Un `QUOTE_STALE` produit par une probe lente est classé `QUOTE_ERRORS`
  (ou `UNPRICED` selon les résultats), pas `failure` : ce n'est pas une
  erreur de scan.
- Une exception de logging ne change pas l'outcome : une probe `success`
  reste `success`, son sample et son attempt sont conservés. Une erreur de
  classification ne produit pas de sample et laisse un attempt
  non-`success` ; elle ne doit pas être confondue avec une erreur de
  logging.
- Une erreur de persistance n'est **pas** une erreur de probe. Une probe
  `success` dont le sample n'est pas persisté ne réactive pas la paire au
  cycle suivant. Le cas `WRITE_FAILED` est traité par D15 (backoff,
  `pendingAttempts`, rotation en mémoire, suspension temporaire) ; les
  autres refus de commit restent gérés comme aujourd'hui : avertissement,
  cycle non échoué, résultats perdus. Un retour `ok: true, written: false`
  n'est pas une panne : aucune écriture n'était nécessaire, mais il ne
  prouve pas non plus que le fichier est inscriptible (D10, D15).
- Une erreur de programmation du scheduler (par exemple un type invalide)
  est capturée à la frontière d'intégration, journalisée
  `probe_scheduler_error`, et désactive les probes pour le cycle. Elle ne
  doit pas être avalée silencieusement.

**Hypothèses.** `classifyEmptyScan` et `bestNetProfitBps` restent les
autorités de classification ; aucune nouvelle règle de pricing n'est
introduite.

### D10 — Persistance dans le Store v2, `source: "probe"`

**Décision.** Les résultats de probe utilisent le **même** fichier
`logs/pair_spreads.json`, le **même** schéma v2 et le **même** appel
`recordPairSpreadCommit` que les scans. Les attempts de probe portent
`source: "probe"`. Les samples n'ont pas de champ `source` (le schéma v2
n'en prévoit pas). Il n'y a **qu'un seul commit par cycle**, après la phase
de probe, avec :

```
samples  = samples de scan + samples de probe
attempts = attempts de scan + attempts de probe
now      = pairSpreadNow
```

**Justification.** Le Store v2 accepte déjà `probe` comme source
(`bot/pairSpreadStore.js:36`) et le commit est atomique
(`recordPairSpreadCommit`). Un second fichier ou un second commit
introduirait deux sources de vérité, un risque d'écriture partielle et une
migration inutile. Un seul commit garantit que samples et attempts d'un
même cycle sont cohérents.

**Conséquences.**

- Aucun nouveau fichier, aucun nouveau schéma, aucune migration.
- Le plafond de 20 attempts par paire est partagé entre scans et probes ;
  les plus récents gagnent. C'est acceptable, car seul le dernier attempt
  compte pour la rotation (D8).
- Une probe réussie produit un sample et un attempt `success` au même
  `at`. Une probe `empty` ou `failure` ne produit aucun sample, donc le
  conflit « sample + attempt non-`success` » du Store ne peut pas se
  produire pour cette probe (`bot/pairSpreadStore.js:791-801`).

**Trois niveaux à distinguer.**

1. **Validité de l'état chargé.** `pairSpreadStateAvailable` et le schéma
   déterminent si l'état peut être utilisé. Un état invalide, corrompu,
   illisible ou de version inconnue ne permet aucune probe (A7).
2. **Indication de capacité d'écriture.** `loaded.writable === true` est une
   indication de **chargement** : le fichier est absent ou lisible et
   conforme au schéma. Il ne teste ni les permissions du répertoire, ni
   l'espace disque, ni le `rename` final. Il n'est **pas** une garantie de
   persistance. `loaded.writable !== true` (en pratique `false`) interdit
   les probes (A7).
3. **Écriture réellement réussie.** Seul le retour de
   `recordPairSpreadCommit` avec `ok: true` **et** `written: true` prouve
   qu'une écriture a eu lieu. Un retour `ok: true, written: false` signifie
   que l'état reçu était identique à l'état chargé **et** qu'aucune entrée
   expirée n'a été purgée : aucun `writeFile`/`rename` n'a été tenté. Ce
   n'est ni une preuve d'écriture ni une preuve d'inscriptibilité ; D15 le
   traite comme un no-op, pas comme un succès.

- Si l'état n'est pas disponible (`pairSpreadStateAvailable === false`) ou
  si `loaded.writable !== true`, **aucune probe n'est exécutée** : le
  commit serait refusé et le coût RPC gaspillé. Un avertissement le
  signale.
- Si `loaded.writable === true`, les probes peuvent être exécutées, mais le
  commit peut encore échouer avec `PAIR_SPREAD_STATE_WRITE_FAILED`
  (`ok: false, written: false, writable: true`). Ce cas est traité par
  D15 : backoff en mémoire, `pendingAttempts`, rotation des candidats et
  suspension temporaire. Les samples et attempts du cycle échoué ne sont
  pas persistés ; une probe `success` perdue ne réactive donc pas la paire
  au cycle suivant. Les attempts complets sont conservés dans
  `pendingAttempts` et ré-émis au commit suivant si leur `at` est
  committable.
- Le commit inclut les attempts de probe du cycle **et** les attempts en
  attente dont `at <= pairSpreadNow` (D15), sous réserve de la garde de
  conflit sample/attempt non-`success`. Un attempt en attente avec
  `at > pairSpreadNow` n'est pas commité et reste dans l'overlay ; il ne
  doit pas rendre l'état non inscriptible. Un attempt non-`success` en
  attente n'est pas ré-émis si le commit courant contient un sample
  **survivant** pour la même clé (le Store refuse cette combinaison,
  `bot/pairSpreadStore.js:791-801`).
- Les samples sont dédupliqués par `at`, en conservant la valeur maximale
  (`bot/pairSpreadStore.js:199-202`) ; les attempts sont dédupliqués sur le
  tuple exact `(at, outcome, source, reason)`. La description « `at` +
  valeur » serait incorrecte pour les samples.
- L'événement `pair_spread_persist` existant expose déjà `attemptsAdded` ;
  aucun champ n'est ajouté. Un événement `pair_spread_probe` distinct
  journalise chaque probe commencée : niveau `debug` pour `success` et
  `empty`, `warn` pour `failure` (D9).

**Hypothèses.** Le Store v2 est la seule source de vérité pour l'historique
du filtre ; aucun appelant externe n'écrit un schéma différent.

### D11 — Un seul `pairSpreadNow` par cycle

**Décision.** Le cycle fixe `pairSpreadNow = Date.now()` **une
seule fois**, au début, après la vérification du `chainId`
(`bot/index.js:258`). Cette valeur sert pour :

- le chargement de l'état (`loadPairSpreadState({ now: pairSpreadNow })`) ;
- les décisions `decidePairSpread` ;
- les samples et attempts de scan ;
- les samples et attempts de probe ;
- le commit (`recordPairSpreadCommit({ now: pairSpreadNow })`).

La phase de probe capture ensuite `probeNow = Date.now()` **une seule
fois**, juste avant la sélection. `probeNow` sert uniquement à :

- la suspension (`probeNow < suspendedUntil`, D15) ;
- le throttle global (`probeNow - lastGlobalProbeAt`) ;
- la valeur écrite dans `lastGlobalProbeAt` au démarrage de la première
  probe du batch ; cette valeur est le `probeNow` capturé au début de la
  phase, pas l'heure réelle de l'entrée dans le wrapper (D7).

L'éligibilité par paire n'utilise **pas** `probeNow` : elle utilise
`pairSpreadNow` (D3, D7), la même horloge que les `at` des samples et
attempts. `probeNow` n'est jamais utilisé comme `at` d'un sample ou d'un
attempt, et n'est jamais persisté. En l'absence de recul d'horloge,
`probeNow >= pairSpreadNow` ; l'écart mesure la durée de la boucle
principale.

Aucun `Date.now()` n'est appelé dans la boucle de probe pour horodater un
sample ou un attempt. `scanPair` peut continuer à utiliser `Date.now()`
en interne pour mesurer l'âge d'une quote (`QUOTE_STALE`) : c'est une
mesure de fraîcheur, pas l'horodatage de l'événement.

**Justification.** Le Store refuse un `at` futur par rapport au `now` du
commit, pour les samples (`bot/pairSpreadStore.js:605`) comme pour les
attempts (`:630`). Si une probe utilisait un `Date.now()` plus récent que
`pairSpreadNow`, son sample serait « futur » et rendrait l'état non
inscriptible. Un horodatage unique rend aussi les tests déterministes et les
échantillons d'un même cycle comparables. L'enveloppe utilise néanmoins
`probeNow`, plus récent, pour que le throttle global et la suspension
mesurent le temps réel du processus et non l'écart entre deux débuts de
cycle. L'éligibilité par paire reste sur `pairSpreadNow`, car elle doit
mesurer l'écart entre les `at` persistés (D3, D7).

**Conséquences.**

- Un cycle long peut produire des samples dont l'`at` est antérieur à la
  fin réelle de la probe. C'est déjà le cas pour les scans : `at` est
  l'heure de décision du cycle, pas l'heure de la quote.
- `probeNow` peut être très postérieur à `pairSpreadNow` ; cela ne crée pas
  de sample futur, car l'`at` persisté reste `pairSpreadNow`. L'écart
  `probeNow - pairSpreadNow` peut varier d'un cycle à l'autre ; il n'affecte
  que le throttle global et la suspension, jamais l'éligibilité par paire.
- Deux cycles ne peuvent pas partager le même `pairSpreadNow` en pratique,
  mais rien ne l'interdit formellement ; le Store déduplique les samples
  par `at` en conservant la valeur maximale
  (`bot/pairSpreadStore.js:199-202`), et les attempts par tuple exact
  `(at, outcome, source, reason)`. La formulation « `at` + valeur » pour
  les samples est incorrecte.
- `lastGlobalProbeAt` n'utilise **pas** `pairSpreadNow` : il est mis à jour
  avec la valeur de `probeNow` capturée au début de la phase, au démarrage
  de la première probe du batch (D6, D7). Ce n'est pas l'heure réelle de
  l'entrée dans le wrapper. Il ne sert jamais d'`at` pour un sample ou un
  attempt.
- `recordProbeAttempt` conserve sa garantie de monotonie : un `at` plus
  ancien ne recule jamais un attempt existant.

**Hypothèses.** L'horloge du processus est stable pendant un cycle ; une
dérive reste possible et est traitée par l'exclusion des timestamps futurs
(D8).

### D12 — Configuration, défauts et limites

**Décision.** Trois variables d'environnement, cohérentes avec le
préfixe existant `PAIR_SPREAD_*` :

| Variable | Type | Défaut | Valeur d'activation | Borne dure | Effet |
|---|---|---|---|---|---|
| `PAIR_SPREAD_PROBE_INTERVAL_MS` | entier ≥ 0 | `0` | `3600000` (1 h) | `<= maxAgeMs / minSamples` (4 h 48 avec les défauts) | intervalle minimal entre deux probes d'une même paire ; `0` désactive les probes |
| `PAIR_SPREAD_PROBE_MAX_PER_CYCLE` | entier 1–10 | `1` | `1` | `<= 10` | nombre maximal de probes tentées par cycle ; `11` est rejeté |
| `PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS` | entier ≥ 0 | `0` | `300000` (5 min) | `<= maxAgeMs / minSamples` | intervalle minimal entre deux démarrages de batchs ; `0` = pas de throttle, accepté seulement si `intervalMs = 0` |

**Justification des défauts.**

- `INTERVAL_MS = 0` préserve le comportement actuel : aucune probe, aucun
  coût RPC, aucun changement d'état. C'est le seul défaut sûr avant
  validation.
- `MAX_PER_CYCLE = 1` est la valeur du prototype et la plus conservative :
  une probe coûte le prix d'un scan complet. La borne `10` est une limite
  dure de sécurité, pas une cible.
- `GLOBAL_INTERVAL_MS = 0` n'ajoute aucune restriction tant que les probes
  sont désactivées. À l'activation, `300000` (5 min) est recommandé : il
  borne à `288 × M` probes/jour au plus et évite qu'un `maxPerCycle = 10`
  produise une rafale toutes les 15 s. `0` n'est pas accepté avec
  `intervalMs > 0`.

**Justification des bornes.**

- `intervalMs <= maxAgeMs / minSamples` est une **marge opérationnelle
  conservative**, et non une condition mathématique nécessaire. La
  condition nécessaire pour que `minSamples` échantillons puissent tenir
  dans la fenêtre est
  `(minSamples - 1) × intervalMs <= maxAgeMs`, soit
  `intervalMs <= maxAgeMs / (minSamples - 1)` (6 h avec les défauts), car le
  premier et le dernier échantillon occupent les deux extrémités. Elle n'est
  pas suffisante : la rotation réelle peut être plus lente. La validation
  retient volontairement la borne plus stricte du prototype (4 h 48), qui
  laisse une marge d'un intervalle. C'est un choix opérationnel, pas une
  condition nécessaire. La période réelle dépend aussi du nombre
  de candidats, de `maxPerCycle`, de l'intervalle global, de la durée des
  cycles et du taux de succès.
- `maxPerCycle <= 10` est une limite de sécurité dure, révisable par un
  futur ADR après mesure. Elle borne la rafale RPC et l'allongement du
  cycle ; elle n'est pas dérivée d'une mesure actuelle.
- `globalIntervalMs <= maxAgeMs / minSamples` applique la même marge
  opérationnelle que l'intervalle par paire ; la condition nécessaire serait
  `maxAgeMs / (minSamples - 1)`. La marge stricte laisse une respiration
  d'un intervalle, sans garantir la capacité réelle.

**Validation par mode.** La validation syntaxique, les bornes et le
couplage sont appliqués **dans tous les modes**, pour qu'un passage à
`enforce` ne révèle pas une configuration invalide. Le tableau suivant
tranche le comportement :

| Mode | Probes exécutées | Validation des réglages | Couplage `intervalMs > 0 ⇒ globalIntervalMs > 0` | Avertissement au démarrage |
|---|---|---|---|---|
| `off` | non | oui, types et bornes | oui | réglages non défaut = inertes |
| `shadow` | non | oui, types et bornes | oui | réglages non défaut = inertes |
| `enforce`, `intervalMs = 0` | non | oui, types et bornes | oui (antécédent faux : rien à exiger) | `maxPerCycle`/`global` non défaut = inertes |
| `enforce`, `intervalMs > 0` | oui | oui, types et bornes | oui, `globalIntervalMs > 0` exigé | activation + capacité |

Ce choix est volontairement **fail-fast** : `off` et `shadow` n'exécutent
aucune probe, mais refusent une combinaison qui serait invalide en
`enforce`. Il évite qu'une configuration « de test » doive être corrigée
au moment de l'activation.

**Traitement des chaînes.** Au niveau environnement :

- variable absente (`undefined`) ou chaîne vide `""` → valeur par défaut ;
- chaîne composée uniquement d'espaces (`"   "`, `"\t"`) → **erreur
  explicite**, jamais `0` ; `Number("   ")` vaut `0`, et ce cas ne doit pas
  désactiver silencieusement les probes ;
- chaîne non vide → `trim()`, puis motif `^[0-9]+$` ; la valeur convertie
  doit être un entier sûr dans les bornes. Rejeter `"1.5"`, `"1e3"`,
  `"+1"`, `"-1"`, `"0x10"`, `"NaN"`, `"Infinity"`, `"null"`, `"true"`.

Un lecteur dédié `optionalProbeInteger(name, fallback)` est requis pour ces
trois variables. Le helper existant `optionalNumber` ne doit pas être
utilisé tel quel : il convertit `"   "` en `0` via `Number("   ")`, ce qui
désactiverait silencieusement les probes. Le lecteur dédié applique la
règle ci-dessus avant toute conversion.

La validation directe de `validatePairSpreadSettings` rejette les chaînes,
les booléens, les objets et les tableaux. Pour les trois réglages numériques,
`undefined` utilise la valeur par défaut de la signature et `null` est
rejeté ; `null` n'est jamais converti en `0`. Seul `pairCount` admet
`undefined` et `null` comme sentinelles (règle ci-dessous).

**Validation.**

- Rejeter les valeurs non entières, négatives, `NaN`, `Infinity`, `null`
  pour les trois réglages numériques, et les chaînes au niveau de la
  fonction de validation ; `pairCount` suit la règle de sentinelle
  ci-dessous.
- Rejeter `maxPerCycle < 1` et `maxPerCycle > 10` ; le test à `11` est
  obligatoire (D13).
- Rejeter `intervalMs > maxAgeMs / minSamples` lorsque `intervalMs > 0`.
- Rejeter `globalIntervalMs > maxAgeMs / minSamples`.
- Rejeter `intervalMs > 0 && globalIntervalMs === 0`.
- `pairCount` est soit une **sentinelle admise** (`undefined` ou `null`),
  soit un **entier sûr `>= 0`** (`0` compris) ; lorsque les probes sont
  actives (`enforce` et `intervalMs > 0`), `undefined`, `null` et `0`
  déclenchent `PROBE_CAPACITY_INDETERMINATE` (D7) ; une valeur fournie qui
  n'est ni une sentinelle admise ni un entier sûr `>= 0` (négative,
  fractionnaire, `NaN`, `Infinity`, non numérique ou supérieure à
  `Number.MAX_SAFE_INTEGER`) est une erreur de validation.
- En mode `off` ou `shadow`, les réglages sont validés mais **inertes** ;
  un avertissement au démarrage le signale, sans erreur supplémentaire liée
  à l'inertie ; le couplage et les bornes restent applicables.
- Si `intervalMs = 0`, `maxPerCycle` et `globalIntervalMs` sont inertes à
  l'exécution, mais restent soumis au type et aux bornes ; un avertissement
  le signale si l'opérateur les a modifiés.
- Au démarrage, journaliser une fois
  `[PAIR SPREAD] probe enabled interval=... maxPerCycle=... globalInterval=...`
  ou `[PAIR SPREAD] probe disabled interval=0 ...`.
- Les avertissements de capacité D7 sont émis **une fois au démarrage**,
  avec `pairCount = config.pairs.length` comme borne supérieure de `N`, et
  jamais à chaque cycle. `pairCount` est un paramètre optionnel de
  `validateScannerConfig`, transmis à `validatePairSpreadSettings` ; c'est
  soit une sentinelle admise (`undefined` ou `null`), soit un entier sûr
  `>= 0` (`0` compris). Si sa valeur est `undefined`, `null` ou `0` alors
  que les probes sont actives (`enforce` et `intervalMs > 0`), émettre
  `PROBE_CAPACITY_INDETERMINATE` (la capacité n'est pas estimable), pas un
  silence. Une valeur fournie qui n'est ni une sentinelle admise ni un
  entier sûr `>= 0` est une erreur de validation, pas un avertissement. Ces
  avertissements ne sont pas fatals. Aucun `PROBE_CAPACITY_IMPOSSIBLE` n'est
  émis : la seule impossibilité démontrable est déjà exclue par la borne
  D12 (D7).

**Capacité nominale et métriques runtime.** Les avertissements
`PROBE_CAPACITY_MARGIN` et `PROBE_CAPACITY_INDETERMINATE` sont des
indicateurs **nominaux** (D7). Ils ne prouvent ni une capacité suffisante,
ni une impossibilité. L'absence d'avertissement ne garantit pas que
`minSamples` sera atteint. Une phase de mesure runtime dans `run.js` (A10)
est requise avant de considérer l'activation en `enforce` comme validée :
nombre réel de candidats, durée des cycles, taux de succès, samples par
paire dans la fenêtre. Aucun seuil numérique n'est fixé par cet ADR ; les
seuils seront définis après mesure.

**Conséquences.**

- Aucune activation implicite : il faut `mode = enforce` **et**
  `intervalMs > 0` **et** `globalIntervalMs > 0`.
- `maxPerCycle` ne peut pas dépasser 10 sans modification de la validation.
- La borne `maxAgeMs / minSamples` dépend de la configuration du filtre ;
  changer `minSamples` ou `maxAgeMs` peut invalider un intervalle existant
  au démarrage. C'est volontaire : mieux vaut un refus explicite qu'un
  intervalle hors de la marge opérationnelle conservative retenue. Cette
  marge n'est pas une condition mathématique nécessaire et ne démontre pas
  qu'une configuration serait incapable de fournir `minSamples` dans la
  fenêtre : la condition nécessaire pour que `minSamples` échantillons
  tiennent dans la fenêtre est `(minSamples - 1) × intervalMs <= maxAgeMs`,
  et elle n'est pas suffisante.
- Une chaîne vide utilise le défaut ; une chaîne d'espaces est refusée.
  Aucun paramètre invalide n'est converti silencieusement en `0`.

**Hypothèses.** Les variables sont lues une fois au démarrage, comme les
autres réglages `PAIR_SPREAD_*` ; aucun rechargement à chaud.

### D13 — Tests

**Décision.** Les tests suivants sont requis avant toute
activation. Ils n'utilisent ni RPC réel, ni `logs/` réel, ni transaction.

**Unitaires (`test/BotPairSpreadProbe.test.js`).**

- `initProbeHistoryFromState` :
  - samples seuls ;
  - attempts seuls (M1) ;
  - samples + attempts, le maximum gagne ;
  - égalité de timestamps ;
  - l'init ne reçoit pas `pendingAttempts` et ne l'applique pas ;
    l'overlay est appliqué par `selectProbeCandidates` ;
  - tableaux absents ou vides ;
  - état non muté ;
  - timestamp futur conservé puis exclu par la sélection ;
  - entrées malformées → erreur explicite.
- `selectProbeCandidates` :
  - contrat complet : les paramètres requis de D3 sont acceptés et
    utilisés ; un paramètre requis manquant ou invalide est rejeté ; les
    optionnels absents prennent leur défaut (`Set`/`Map` vides) et un
    optionnel fourni invalide est rejeté ;
  - forme de retour `{ selected: [{ key, pair, lastAt }], nextCursorKey }` :
    `selected` est un nouveau tableau, chaque élément est un nouvel objet,
    `lastAt = -1` pour une clé jamais observée ;
  - `intervalMs = 0` → `selected = []` et `nextCursorKey = cursorKey`,
    même avec des candidats éligibles ; les autres réglages sont validés
    mais inertes à l'exécution ;
  - filtre des clés vides : une entrée sans `key` ou avec `key: ""` est
    ignorée, ne consomme pas de slot et ne fait pas échouer l'appel ; son
    `pair` n'est pas validé ; un conteneur invalide (`candidates` non
    tableau, `history` non `Map`) lève ;
  - validation des éléments de `candidates` : un élément `null`, non-objet
    ou tableau lève ; une entrée avec `key` non vide mais `pair` absent,
    `null`, tableau ou non-objet lève ; aucune entrée malformée n'est
    ignorée silencieusement en dehors du filtre des clés vides ;
  - `pendingAttempts` absent → pas d'overlay ; fourni → overlay appliqué ;
  - déduplication des clés, première occurrence conservée ;
  - exclusion de `scannedKeys` et `probedKeys` (D5) ;
  - `maxPerCycle` strict ;
  - `maxPerCycle = 1` et `10` acceptés ; `0` et `11` rejetés (test
    explicite pour `11`) ;
  - filtre d'intervalle appliqué **avant** la sélection : une paire trop
    récente ne consomme pas de slot ;
  - ordre lexicographique croissant, indépendant de l'ordre d'entrée ;
  - `cursorKey = null` démarre à la première clé lexicale ;
  - `cursorKey` présent démarre à la clé **immédiatement suivante** dans
    l'ordre lexical ; il ne démarre pas sur `cursorKey` lui-même lorsque
    plusieurs clés candidates existent ; si `cursorKey` est l'unique clé
    candidate, cette clé est examinée une fois, sans répétition ;
  - `cursorKey` absent de la liste (y compris une clé supprimée) démarre à
    la première clé lexicale, et non à la première clé supérieure ;
  - wrap lorsque `cursorKey` est la dernière clé ;
  - `nextCursorKey` = dernière clé examinée, y compris pour un batch vide ;
  - une clé non éligible est sautée sans consommer de slot et sans
    interrompre le parcours ;
  - paire jamais sondée (`lastAt = -1`) éligible sans appliquer le filtre
    d'intervalle, y compris avec un `pairSpreadNow` faible (test de la
    sentinelle) ;
  - `pairSpreadNow` est utilisé pour l'intervalle et le contrôle de futur,
    pas `probeNow` ;
  - un `probeNow` postérieur à `pairSpreadNow` ne rend pas éligible une
    paire déjà observée dont `pairSpreadNow - lastAt < intervalMs` ;
  - overlay `pendingAttempts` : le maximum gagne ; une clé présente
    seulement dans l'overlay contribue à `lastAt` mais n'est **pas**
    sélectionnée si elle ne figure pas dans `candidates` ; un `at` plus
    récent retarde la paire ; une incohérence `mapKey !== entry.key` lève ;
  - timestamp futur exclu ;
  - entrées malformées de conteneur ou sentinelle invalide → erreur ; clé
    vide → ignorée par le filtre, pas une erreur.
- Curseur, parcours et annulation :
  - **aucune clé candidate** : `selected = []` et
    `nextCursorKey = cursorKey`, même si `cursorKey` est `null` ou ne
    correspond à aucune clé ;
  - **clés candidates, aucune éligible** : toutes les clés sont examinées,
    `selected = []` et `nextCursorKey` est la dernière clé du parcours ;
    si le parcours a commencé après `cursorKey`, cette dernière clé est
    `cursorKey` ; si `cursorKey` est absent ou supprimé, c'est la dernière
    clé lexicale ;
  - **parcours complet revenant à la clé de départ** : la clé de départ
    n'est pas réexaminée ; la dernière clé examinée est la clé
    immédiatement précédente dans l'ordre circulaire ;
  - **départ** : `cursorKey` présent → clé immédiatement suivante (wrap si
    dernière) ; `cursorKey` absent, `null` ou supprimé → première clé
    lexicale, jamais la première clé `> cursorKey` ; une clé candidate
    unique est examinée une fois, sans répétition, et `nextCursorKey` reste
    cette clé ;
  - **arrêt après `maxPerCycle` sélections** : `nextCursorKey` est la
    dernière clé sélectionnée, qui est la dernière clé examinée ;
  - **clé non éligible** : elle est examinée sans consommer de slot et
    n'interrompt pas le parcours ;
  - **clé exclue par D5** : elle est examinée et résolue, peut être
    dépassée, ne produit ni attempt ni sample ;
  - **clé non sélectionnée** : elle peut être dépassée si elle a été
    examinée (elle est alors résolue) ; si le parcours s'est arrêté avant
    de l'examiner, le curseur s'arrête avant elle ;
  - N = 3, M = 2, plusieurs batchs successifs : chaque clé est sélectionnée
    au moins une fois dans toute fenêtre de `ceil(3/2) = 2` batchs ; les
    séquences attendues doivent être vérifiées ;
  - N = 5, M = 2, plusieurs batchs successifs : chaque clé est sélectionnée
    au moins une fois dans toute fenêtre de `ceil(5/2) = 3` batchs ;
    l'écart entre deux sélections d'une même clé est de 2 ou 3 batchs ;
  - annulation avant le premier appel, aucune probe commencée : le curseur
    reste inchangé si aucune clé n'est résolue ; les clés non commencées
    sont resélectionnées au batch suivant ;
  - annulation après le début d'une probe : le curseur s'arrête à la
    dernière clé résolue ; les clés suivantes non commencées sont
    resélectionnées au batch suivant ;
  - **clé sélectionnée mais non commencée après annulation** : elle reste
    non résolue et le curseur runtime ne la dépasse pas, même si
    `nextCursorKey` la dépasse ;
  - échec de probe : la clé est commencée et résolue, le curseur avance,
    l'attempt `failure` est enregistrée ;
  - échec de persistance : toutes les probes commencées sont résolues, le
    curseur avance, les attempts sont conservés dans `pendingAttempts` ;
    aucune clé ne reste non résolue du seul fait du `WRITE_FAILED`.
- Classification et logging :
  - chaque probe commencée émet exactement un événement `pair_spread_probe`
    avec clé, label, outcome, raison et durée ; niveau `debug` pour
    `success` et `empty`, `warn` pour `failure` ;
  - une probe non commencée (exclue par D5 ou annulée avant le wrapper)
    n'émet pas `pair_spread_probe` ;
  - le nombre d'événements par cycle est borné par `maxPerCycle` ;
  - logger qui lève après une probe réussie : outcome `success`, sample
    conservé, attempt `success`, cycle non échoué ;
  - logger qui lève après une probe en échec : outcome `failure` inchangé ;
  - classification qui lève : aucun sample, attempt non-`success`, aucun
    conflit sample/attempt au commit ;
  - une erreur de logging ne modifie ni l'outcome ni l'attempt.
- `recordProbeAttempt` :
  - nouveau `Map`, entrée non mutée ;
  - un `at` plus ancien ne recule pas ;
  - clé ou `at` invalide → erreur.
- Intervalle global (tests **obligatoires**, pas conditionnels) :
  - premier batch autorisé quand `lastGlobalProbeAt = null` ;
  - batch suivant refusé avant l'intervalle ;
  - batch suivant autorisé après l'intervalle ;
  - `globalIntervalMs = 0` = pas de throttle au niveau pur ;
  - un batch vide ne met pas à jour `lastGlobalProbeAt` ;
  - un batch dont toutes les clés sont exclues par D5 ne met pas à jour
    `lastGlobalProbeAt` ;
  - un batch dont toutes les probes échouent met à jour
    `lastGlobalProbeAt` ;
  - `probeNow < lastGlobalProbeAt` (horloge reculée) bloque le batch ;
  - un batch suspendu par le backoff ne met pas à jour
    `lastGlobalProbeAt` ;
  - la suspension est consultée avant le throttle global et avant
    l'intervalle par paire.

**Configuration (`test/ValidatePairSpreadProbeConfig.test.js`).**

- défauts `0`, `1`, `0` ;
- valeurs invalides (négatives, flottantes, `NaN`, `Infinity`, chaînes,
  `null`, booléens, objets) ;
- `maxPerCycle = 0` rejeté ;
- `maxPerCycle = 11` rejeté (test explicite) ;
- `intervalMs > maxAgeMs / minSamples` rejeté ;
- `globalIntervalMs > maxAgeMs / minSamples` rejeté ;
- `intervalMs > 0 && globalIntervalMs = 0` rejeté ;
- chaîne vide `""` → défaut ; chaîne d'espaces `"   "` → erreur, jamais
  `0` ; le lecteur dédié doit être testé séparément de `optionalNumber` ;
- mode `off`/`shadow` : réglages validés mais inertes, avertissement, pas
  d'erreur liée à l'inertie ; le couplage `intervalMs > 0 ⇒ global > 0`
  reste appliqué ;
- mode `enforce` + `intervalMs = 0` : probes désactivées, pas d'erreur ;
- mode `enforce` + `intervalMs > 0` + `globalIntervalMs > 0` : activation ;
- `pairCount` sentinelle (`undefined` ou `null`) ou `0` + probes actives →
  `PROBE_CAPACITY_INDETERMINATE` ; `pairCount` entier sûr strictement
  positif → seuils calculés ; `pairCount` fourni qui n'est pas un entier sûr
  `>= 0` (négatif, fractionnaire, `NaN`, `Infinity`,
  `> Number.MAX_SAFE_INTEGER`, ou non numérique) → erreur de validation ;
  aucun `PROBE_CAPACITY_IMPOSSIBLE` n'est émis ;
- chargement depuis l'environnement et propagation via
  `validateScannerConfig`.

**Intégration (`test/BotPairSpreadProbeIntegration.test.js`, nouveau).**

- `enforce`, une paire filtrée + une paire active : la paire active est
  scannée, la paire filtrée est sondée, aucun chevauchement.
- Une probe réussie écrit un sample et un attempt `source: "probe"` ; un
  seul `recordPairSpreadCommit` est appelé.
- Aucun enregistrement `scans.jsonl` pour une probe ; `scanned`,
  `opportunities`, `executed`, `rpcErrors`, `pairErrors` inchangés.
- Probe en échec (`scanPair` lève) : attempt `failure`/`SCAN_ERROR`,
  aucun sample, `exitCode` inchangé ; si toutes les paires sont filtrées,
  `exitCode = 0`.
- Probe vide : `NO_RESULTS`, `QUOTE_ERRORS`, `UNPRICED` selon les résultats.
- Probe réussie avec `bps >= plancher` et médiane encore sous le plancher :
  au cycle suivant, la paire n'est plus filtrée et est scannée
  (`LAST_AT_OR_ABOVE_FLOOR`).
- Probe réussie avec `bps >= plancher` et médiane au-dessus du plancher :
  réactivation avec `MEDIAN_AT_OR_ABOVE_FLOOR`.
- Probe réussie avec `bps < plancher` et médiane toujours sous le plancher :
  la paire reste filtrée (`PAIR_SPREAD_BELOW_FLOOR`). C'est le scénario
  explicitement fixé par ce test.
- Doublon de configuration : deux entrées de même route mais tailles
  différentes → une seule probe. Deux entrées avec des routeurs différents
  → deux clés distinctes, pas un doublon.
- Candidat déjà scanné : aucune probe (D5).
- État indisponible ou `loaded.writable !== true` : aucune probe.
- Probes désactivées : aucun appel RPC supplémentaire.
- Mode `off`/`shadow` : aucune probe.
- `probe_scheduler_error` : le scheduler lève (par exemple un paramètre
  invalide injecté à la frontière d'intégration) ; l'événement est journalisé
  en `warn`, les probes sont désactivées pour le cycle, le scan normal se
  poursuit et se termine, aucun appel RPC de probe n'est émis,
  `lastGlobalProbeAt` et `cursorKey` restent inchangés et `exitCode` est
  inchangé.
- `pair_spread_probe_history_error` : `initProbeHistoryFromState` lève sur un
  état malformé ; l'événement est journalisé en `warn`, les probes sont
  désactivées pour le cycle, le scan normal se poursuit, les samples et
  attempts de scan sont commités normalement, aucune probe n'est tentée,
  `lastGlobalProbeAt` et `cursorKey` restent inchangés et `exitCode` est
  inchangé.
- Intervalle global : `lastGlobalProbeAt` reçoit la valeur de `probeNow`
  capturée au début de la phase, au démarrage de la première probe du
  batch ; ce n'est ni `pairSpreadNow`, ni l'heure réelle de l'entrée dans le
  wrapper, ni la sélection ; un batch vide ne le met pas à jour ; un batch
  dont toutes les clés sont exclues par D5 ne le met pas à jour ; un batch
  dont toutes les probes échouent le met à jour ; l'état est conservé entre
  deux appels de `main()` dans le même processus et perdu avec un runtime
  neuf (simulation de redémarrage).
- Horloges : un `probeNow` postérieur à `pairSpreadNow` ne change pas l'`at`
  des samples ou attempts ; le throttle global et la suspension utilisent
  `probeNow` ; l'éligibilité par paire utilise `pairSpreadNow`, donc un
  `probeNow` très postérieur ne raccourcit pas l'intervalle entre deux
  attempts.
- Curseur : un runtime neuf démarre à `cursorKey = null` ; N = 3, M = 2 et
  N = 5, M = 2 avec plusieurs batchs successifs couvrent les clés selon
  D3 ; le curseur survit aux appels de `main()` du même processus et repart
  à `null` avec un runtime neuf ; un batch vide peut avancer le curseur
  sans consommer de slot ; un `WRITE_FAILED` n'empêche pas l'avancement du
  curseur : toutes les probes commencées sont résolues et aucune clé ne
  reste non résolue du seul fait de l'échec d'écriture ; une annulation
  avant le premier appel laisse le curseur inchangé si aucune clé n'est
  résolue ; une annulation après le début d'une probe arrête le curseur à
  la dernière clé résolue et la clé non commencée est resélectionnée au
  batch suivant.
- Panne d'écriture : `recordPairSpreadCommit` retourne
  `PAIR_SPREAD_STATE_WRITE_FAILED` ; le cycle reste non échoué ; le backoff
  suit 5 → 10 → 20 → 40 → 60 min puis plafonne à 1 h (plafonds de
  suspension) ; aucune nouvelle probe avant `suspendedUntil` ; les attempts
  complets du cycle (scan et probe) sont conservés dans `pendingAttempts` ;
  au commit suivant, ils sont ré-émis si `at <= pairSpreadNow` et retirés
  seulement après `commitSucceeded` ; un attempt dont `at > pairSpreadNow`
  reste dans l'overlay et n'est pas commité ; après le backoff, la rotation
  continue sur les autres candidats.
- `commitSucceeded` : `ok: true` + `written: true` réinitialise
  `writeFailures` et `suspendedUntil`, lève la suspension par anticipation
  et retire de `pendingAttempts` toutes les entrées dont
  `at <= pairSpreadNow`, y compris celles écartées du commit par la garde de
  conflit ; les entrées dont `at > pairSpreadNow` restent ; `ok: true` +
  `written: false` ne réinitialise rien, ne lève pas la suspension, ne vide
  rien et ne retire rien (no-op) ; `ok: false` + `WRITE_FAILED` arme le
  backoff ; un refus non-`WRITE_FAILED` n'arme pas le backoff ; un
  redémarrage perd l'overlay, le backoff et le curseur, et peut sonder une
  paire plus tôt que `intervalMs` (limite documentée).
- No-op avec overlay : un `pendingAttempts` non vide et un commit
  `ok: true, written: false` ne retirent aucune entrée ; plusieurs no-op
  consécutifs ne la retirent pas ; une écriture réelle ultérieure
  (`ok && written`) la retire selon la règle. Aucune entrée n'est retirée
  au seul motif que le commit est un no-op.
- No-op et garde de conflit : un attempt non-`success` en attente, écarté
  du tableau `attempts` parce qu'un sample **survivant** existe pour la même
  clé, reste dans `pendingAttempts` lorsque le commit est un no-op ; il peut
  y rester tant qu'aucune écriture réelle ne permet sa résolution. Le test
  ne doit pas supposer qu'une « prochaine écriture » le retirera.
- Refus déterministe retourné : le commit retourne `ok: false` avec un code
  autre que `WRITE_FAILED` (`CORRUPT`, `SCHEMA_INVALID`, `UNREADABLE`,
  version inconnue, `writable: false`) ; aucun backoff n'est armé, les
  attempts du cycle ne sont pas fusionnés, l'overlay existant est conservé
  et l'erreur est journalisée.
- Refus déterministe par `error.code` stable : le commit lève une erreur
  dont `error.code` vaut exactement
  `PAIR_SPREAD_STATE_VALIDATION_FAILED` ou
  `PAIR_SPREAD_STATE_CONFLICT` (mécanisme **à implémenter** dans
  `bot/pairSpreadStore.js`, absent aujourd'hui) ; aucun backoff n'est armé,
  les attempts du cycle ne sont pas fusionnés, l'overlay existant est
  conservé et l'erreur est journalisée. Le conflit est levé, pas retourné en
  `ok: false`. Aucune autre valeur de `error.code` n'est déterministe.
- Exception `TypeError`/`RangeError` **sans** `error.code` stable : classée
  inattendue (fusion dans `pendingAttempts`, aucun backoff), afin de vérifier
  que le classificateur ne repose pas sur `instanceof`.
- Exception de commit inattendue (sans `error.code` déterministe reconnu) : le
  commit lève une autre erreur ; aucun backoff n'est armé, `writeFailures`
  reste inchangé, les attempts du cycle sont fusionnés dans
  `pendingAttempts`, l'overlay existant est conservé, le cycle reste non
  échoué et le prochain cycle retente.
- Logging et classification : une exception du logger après une probe
  réussie conserve l'outcome `success`, le sample et l'attempt `success` ;
  une exception de classification ne produit aucun sample et laisse un
  attempt non-`success`, sans conflit Store.
- Garde de conflit : un attempt `empty`/`failure` en attente n'est pas
  ré-émis si le commit courant contient un sample **survivant** pour la
  même clé ; si le commit réussit (`ok && written`), il est retiré de
  `pendingAttempts` ; si le commit échoue ou est un no-op, il reste ; un
  attempt `success` en attente est ré-émis avec le sample.
- Avertissement de capacité : émis une fois au démarrage, pas à chaque
  cycle ; absent si `intervalMs = 0` ou si le mode est `off`/`shadow` ;
  `PROBE_CAPACITY_INDETERMINATE` si `pairCount` est `undefined`, `null` ou
  `0` alors que les probes sont actives ; `PROBE_CAPACITY_MARGIN` avec
  `pairCount` comme borne supérieure ; aucun
  `PROBE_CAPACITY_IMPOSSIBLE`.

**Régression Store (`test/BotPairSpreadStore.test.js`).**

- `source: "probe"` accepté ;
- un seul commit par cycle ;
- plafond de 20 attempts respecté ;
- déduplication des samples par `at`, valeur maximale conservée ;
- déduplication des attempts sur `(at, outcome, source, reason)` ;
- un attempt `failure`/`SCAN_ERROR` seul, sans sample, est accepté (cas
  d'une exception de classification) ;
- aucun sample n'est fabriqué depuis un attempt ;
- conflit sample + attempt non-`success` non déclenché par une probe
  normale ;
- migration v1 inchangée ;
- un refus de validation ou de conflit expose un `error.code` stable, distinct
  d'une exception inattendue (mécanisme à implémenter avec le Store ; non
  exécuté par cet ADR) ;
- forme du résultat `WRITE_FAILED` (`ok: false`, `written: false`,
  `writable: true`, code `PAIR_SPREAD_STATE_WRITE_FAILED`).

**Statut des tests (2026-11-24).** Les fichiers
`test/BotPairSpreadProbe.test.js` et
`test/ValidatePairSpreadProbeConfig.test.js` sont présents dans l'arbre de
travail, non commités, aux côtés de
`test/BotPairSpreadProbeIntegration.test.js`. Ils couvrent le contrat retenu
et les adaptations décrites ci-dessous, qui ont été appliquées :

- les tests qui encodent des décisions toujours valides sont conservés ou
  étendus : défauts `0`/`1`, validation de `intervalMs >= 0`, rejet des
  valeurs non entières, déduplication en conservant la première occurrence,
  `maxPerCycle` strict, filtre d'intervalle, non-mutation des entrées,
  monotonie de `recordProbeAttempt` ;
- les assertions devenues incompatibles avec le contrat accepté sont
  adaptées ou remplacées : ordre de sélection par `lastAt` (ancien
  comportement), forme de retour `{ key, pair, lastAttemptAt }` ou tableau
  brut, signature `{ now }` sans `globalIntervalMs`, `lastGlobalProbeAt`,
  `suspendedUntil`, `cursorKey`, `pendingAttempts`, `scannedKeys`,
  `probedKeys`, validation `maxPerCycle >= 1` sans borne `<= 10`, et rejet
  d'une clé vide au lieu de son filtrage ;
- les anciennes assertions de tri par `lastAt` ou de forme de retour ne
  doivent pas être conservées artificiellement si elles contredisent le
  contrat retenu. Un test de non-régression doit vérifier l'ordre
  lexicographique et le parcours par curseur, pas l'ancien tri ;
- `initProbeHistoryFromState` doit être étendu aux attempts (M1), aux paires
  à attempts seules et au maximum samples/attempts ; les tests samples-seuls
  restent valides comme sous-ensemble.

**Exécution après implémentation.** `npx hardhat test` doit rester vert.
Les tests existants ne doivent pas être modifiés pour masquer un défaut ;
tout changement d'attente doit être justifié par une décision de cet ADR.
Les adaptations des tests du prototype décrites ci-dessus sont des
changements de contrat documentés, pas un masquage de défaut. Les tests D13
sont présents dans l'arbre de travail ; leur validation opérationnelle
complète reste à effectuer.

### D14 — Exclusions, invariants de sécurité et amendement d'architecture

**Décision.** L'implémentation des probes ne doit introduire :

- aucune transaction, aucun envoi, aucune signature, aucun appel à
  `maybeExecute` ;
- aucun changement de réseau, de `chainId`, de provider ou de
  configuration RPC ;
- aucune modification de `contracts/FlashArbExecutor.sol`, de l'ABI, de
  `bot/execute.js`, de `bot/guards.js`, du breaker ou de l'adaptive ;
- aucune modification de `decide()` ni de son contrat ;
- aucune modification de `scans.jsonl` ni de son format ;
- aucun nouveau fichier d'état, aucun nouveau schéma, aucune migration ;
  `lastGlobalProbeAt`, `writeFailures`, `suspendedUntil`, `pendingAttempts`
  et `cursorKey` restent en mémoire (D6, D15) ;
- aucune modification de l'ADR 0006 ;
- aucun mode par paire, aucun multi-hop, aucun backfill ;
- aucun verrou inter-process, aucune nouvelle dépendance ;
- aucun secret, URL RPC ou trace dans les logs.

Les probes restent read-only **même en `DRY_RUN=false`** : le fait qu'elles
utilisent `scanPair` ne leur donne aucun droit d'exécution. Le flag
`DRY_RUN` n'est pas modifié par cet ADR.

**Amendement de l'invariant d'architecture.** L'invariant pair-spread de
`bot/ARCHITECTURE.md:213-233` est étendu, pas remplacé. Après implémentation,
il doit énoncer en plus :

- une probe n'est exécutée que pour une paire filtrée en `enforce` ;
- `scannedKeys ∩ probedKeys = ∅` dans un cycle ;
- une probe ne produit ni `scans.jsonl`, ni compteur, ni `maybeExecute`, ni
  effet sur `exitCode`, le breaker ou l'adaptive ;
- les samples et attempts de probe sont commités avec le même
  `pairSpreadNow` et le même `recordPairSpreadCommit` que les scans ;
- `lastGlobalProbeAt`, `writeFailures`, `suspendedUntil`, `pendingAttempts`
  et `cursorKey` sont des états de processus, jamais persistés ;
- un `WRITE_FAILED` suspend les probes avec backoff, conserve les attempts
  complets en attente et ne fabrique jamais de sample (D15) ;
- seule une écriture réelle (`ok: true` et `written: true`) réinitialise le
  backoff et retire les attempts en attente ;
- le curseur ne dépasse aucune clé sélectionnée non résolue ; une clé
  exclue par D5 est résolue et peut être dépassée ; après une **annulation**,
  les clés sélectionnées non commencées restent devant le curseur ; après un
  **`WRITE_FAILED`**, toutes les probes commencées sont résolues et le
  curseur avance selon D3/D15 — l'échec d'écriture ne laisse pas à lui seul
  une clé non résolue devant le curseur ;
- une exception de logging ne modifie ni l'outcome, ni le sample, ni
  l'attempt ; une exception de classification ne produit aucun sample et
  laisse un attempt non-`success` (D9) ;
- une exception de commit sans `error.code` déterministe reconnu est
  inattendue : elle n'est pas assimilée à un `WRITE_FAILED`, n'arme pas le
  backoff et ses attempts sont conservés en mémoire ;
- une exception de validation ou un conflit Store n'est déterministe que si
  elle porte un `error.code` Store stable (mécanisme à implémenter) ; elle n'est
  alors pas fusionnée dans `pendingAttempts` ; un refus retourné
  non-`WRITE_FAILED` non plus ; seul `commitSucceeded` lève la suspension par
  anticipation (D15).

La mise à jour de `bot/ARCHITECTURE.md` fait partie de la section 8 ; elle
ne modifie pas l'invariant du filtre lui-même.

### D15 — Panne d'écriture : backoff, rotation en mémoire et suspension

**Décision.** Un échec d'écriture du Store n'est pas une erreur de
probe (D9) et ne doit ni faire échouer le cycle, ni provoquer une rafale de
probes vouées à l'échec. Le runtime de probes de `bot/index.js` (D6) porte
les champs dédiés suivants :

- `writeFailures` : nombre de `WRITE_FAILED` consécutifs depuis le dernier
  `commitSucceeded` ;
- `suspendedUntil` : timestamp avant lequel aucune probe n'est lancée ;
- `pendingAttempts` : `Map<key, { key, at, outcome, source, reason? }>` des
  attempts du ou des cycles dont le commit a échoué, utilisée pour la
  rotation **et** pour la ré-émission ;
- `cursorKey` : curseur de fairness (D3), indépendant de la panne.

**Définition de `commitSucceeded`.** Pour tout ce chapitre :

```
commitSucceeded = result.ok === true && result.written === true
```

Seul `commitSucceeded` prouve qu'une écriture réelle a eu lieu. Un retour
`ok: true, written: false` signifie que `recordPairSpreadCommit` n'a pas
tenté d'écriture (état identique et aucune entrée expirée à purger) : il ne
prouve ni l'écriture, ni l'inscriptibilité, et il ne doit réinitialiser ni le
backoff, ni `suspendedUntil`, ni retirer une entrée de `pendingAttempts`.
C'est un no-op du point de vue de D15. Un retour `ok: false` n'est jamais un
succès, même avec `written: false`.

**Déclencheur.** La panne est reconnue quand `recordPairSpreadCommit`
retourne `ok: false` avec `written: false`, `writable: true` et
`error.code === "PAIR_SPREAD_STATE_WRITE_FAILED"`
(`bot/pairSpreadStore.js:958-982`). Les autres refus (`CORRUPT`,
`SCHEMA_INVALID`, `UNREADABLE`, version inconnue, `writable: false`) ne sont
pas transitoires : ils ne déclenchent pas le backoff ; les probes sont déjà
désactivées si `loaded.writable !== true` (D10), et un refus survenu en
cours de cycle est journalisé puis laissé au prochain chargement. Le backoff
est armé même si le cycle ne contenait aucune probe : cela évite qu'un cycle
suivant lance des probes vers un Store dont l'écriture vient d'échouer.

**Cas non assimilés à un `WRITE_FAILED`.** Quatre situations restent
distinctes :

- **Refus déterministe retourné.** Si le commit retourne `ok: false` avec un
  code autre que `PAIR_SPREAD_STATE_WRITE_FAILED` (`CORRUPT`,
  `SCHEMA_INVALID`, `UNREADABLE`, version inconnue, `writable: false`), le
  refus est déterministe et antérieur à l'écriture. Aucun backoff n'est armé.
  Les attempts du cycle ne sont **pas** fusionnés dans `pendingAttempts` :
  les ré-émettre reproduirait le même refus à chaque cycle et empoisonnerait
  l'overlay. L'overlay existant est conservé, l'erreur est journalisée et
  l'opérateur doit corriger la cause. Les probes sont déjà désactivées si
  `loaded.writable !== true` (D10).
- **Exception de validation ou de conflit (refus déterministe).**
  `recordPairSpreadCommit` peut refuser **avant toute écriture** une
  validation des arguments, des samples ou des attempts entrants, ou un
  conflit sample / attempt non-`success`
  (`bot/pairSpreadStore.js`). Chaque refus déterministe expose
  **`error.code`** (propriété unique, jamais un `tag`, jamais `instanceof`,
  jamais le message) avec exactement l'une des deux valeurs suivantes :
  - `PAIR_SPREAD_STATE_VALIDATION_FAILED` : validation des arguments du
    commit, des samples entrants ou des attempts entrants ;
  - `PAIR_SPREAD_STATE_CONFLICT` : conflit sample / attempt
    non-`success` pour une même clé.

  Ces codes sont définis dans `PAIR_SPREAD_STORE_CODES` et posés par
  `storeValidationError` / `storeConflictError` ; l'erreur conserve sa
  classe d'origine (`TypeError`/`RangeError`), mais cette classe ne
  participe pas à la classification : une même classe peut aussi provenir
  d'une erreur de programmation ou d'une cause inattendue. Le wrapper de
  commit (`bot/index.js`, `PROBE_DETERMINISTIC_COMMIT_CODES` et
  `isDeterministicCommitCode`) classe **uniquement** sur `error.code` et ces
  deux valeurs ; toute autre valeur ou l'absence de `error.code` est
  inattendue. Aucun classificateur `instanceof` n'est utilisé. Le mécanisme
  est implémenté dans `bot/pairSpreadStore.js` et `bot/index.js` ; les tests
  Store et d'intégration le couvrent.
  - Refus déterministe reconnu par `error.code` : aucun backoff, attempts
    du cycle non fusionnés dans `pendingAttempts`, overlay existant
    conservé, erreur journalisée et opérateur invité à corriger la cause.
  - Exception sans `error.code` déterministe reconnu : elle est classée
    **inattendue** (bullet suivant) : issue incertaine, aucun backoff,
    attempts du cycle fusionnés dans l'overlay. La règle est déterministe :
    elle dépend de la présence et de la valeur de `error.code`, jamais d'une
    heuristique `instanceof` ou de message. Une erreur de programmation sans
    code est donc inattendue, pas déterministe ; l'ancienne clause « en cas
    de doute, déterministe » est supprimée.
- **Exception de commit inattendue.** Toute exception sans `error.code`
  déterministe reconnu (I/O, erreur de programmation, cause inconnue) laisse
  l'issue de l'écriture incertaine. Aucun backoff n'est armé et
  `writeFailures` reste inchangé. Les attempts du cycle (scan et probe) sont
  fusionnés dans `pendingAttempts` ; l'overlay existant est conservé ; le
  cycle reste non échoué ; l'événement est journalisé et le cycle suivant
  retente. Cette conservation est conservatrice : une écriture partielle ne
  peut pas être distinguée d'une absence d'écriture, et la ré-émission est
  idempotente grâce à la déduplication du Store. `pendingAttempts` ne
  contient jamais de sample : un sample dont l'écriture a échoué est perdu.
- **`ok: true, written: false`.** No-op documenté ci-dessus : ni backoff, ni
  réinitialisation, ni retrait, ni fusion. L'état est identique et aucune
  entrée n'était à purger ; il n'y a rien à ré-émettre. Un no-op ne prouve
  pas qu'une écriture réussira plus tard et ne retire **jamais** une entrée
  de `pendingAttempts`, même si la garde de conflit a exclu cette entrée du
  tableau `attempts` du commit. Des entrées peuvent donc rester dans
  l'overlay tant qu'aucune écriture effective (`ok && written`) ne permet
  leur résolution ; voir la conséquence correspondante.

Un `ok: false` avec `written: true` est incohérent : il est traité comme un
refus déterministe, journalisé, sans backoff et sans fusion.

**Contenu de `pendingAttempts`.** Chaque entrée est un attempt **complet**,
avec `key`, `at`, `outcome` (`success`, `empty` ou `failure`), `source`
(`scan` ou `probe`) et, si présent, `reason`. Un `at` seul ne suffirait
pas : le Store exige `outcome` et `source` pour accepter un attempt, donc
un overlay d'horodatage ne pourrait pas être ré-émis. La fusion conserve
l'attempt de `at` maximal par clé ; les attempts plus anciens de la même
clé sont écartés, car seul le plus récent compte pour la rotation (D8) et
le Store plafonne de toute façon l'historique. `pendingAttempts` ne contient
jamais de sample : un sample non persisté est perdu et ne doit pas réactiver
une paire.

**Effet d'un `WRITE_FAILED`.**

1. `writeFailures += 1`.
2. `backoffMs = min(300000 × 2^(writeFailures - 1), 3600000)` :
   5 min, 10 min, 20 min, 40 min, 60 min, puis 60 min.
3. `suspendedUntil = Date.now() + backoffMs` au moment du commit échoué.
4. Les attempts du cycle (scan et probe), complets, sont fusionnés dans
   `pendingAttempts` en conservant l'attempt de `at` maximal par clé. Les
   samples du cycle ne sont pas conservés : ils n'ont pas été persistés et
   ne doivent pas réactiver une paire.
5. Le cycle reste un succès : `exitCode` inchangé, aucun compteur de scan
   modifié, aucun breaker/adaptive.
6. Un événement `pair_spread_probe_write_failed` de niveau `warn` expose
   `writeFailures`, `backoffMs`, `suspendedUntil`, la taille de
   `pendingAttempts` et le code, sans secret ni URL RPC.

**Ré-émission au commit suivant.** À chaque cycle, le commit inclut :

```
attempts = attempts de scan du cycle
         + attempts de probe du cycle
         + { pendingAttempts.get(key) : at <= pairSpreadNow }
```

Les entrées dont `at > pairSpreadNow` ne sont **pas** commitées : elles
restent dans l'overlay et seront ré-émises lorsqu'un cycle aura
`pairSpreadNow >= at`. Cette garde évite de rendre l'état non inscriptible
avec un `at` futur (D11). Si le commit échoue encore avec un `WRITE_FAILED`
ou une exception inattendue, les attempts du cycle sont fusionnés dans
l'overlay ; les entrées déjà présentes ne reculent jamais. Un refus
déterministe ou une exception de validation/conflit ne fusionne rien
(ci-dessous).

**Garde de conflit sample / attempt non-`success`.** Le Store refuse de
commiter, dans un **même commit**, un attempt non-`success` et un sample
**survivant** pour la même clé (`bot/pairSpreadStore.js:791-801`), même si
les `at` diffèrent. Un attempt en attente `empty` ou `failure` n'est donc
ré-émis que si le commit courant ne contient aucun sample **survivant** pour
cette clé :

- s'il y a un sample survivant pour la clé, l'attempt en attente est exclu
  du tableau `attempts` du commit ;
- si `commitSucceeded`, il est retiré de `pendingAttempts` : le sample
  persisté est plus récent et suffit à la rotation ;
- si `ok: true, written: false` (no-op), il reste dans l'overlay : aucune
  écriture réelle n'a eu lieu, même si le sample était déjà persisté et a
  été écarté du tableau par la garde. Un no-op ne résout pas l'entrée ;
- si le commit échoue, il reste dans l'overlay, car le sample n'a pas été
  persisté.

Un attempt en attente `success` n'est pas concerné : le Store accepte un
attempt `success` et un sample pour la même clé.

Après le commit :

- si `commitSucceeded` : retirer de `pendingAttempts` les entrées qui ont été
  incluses dans le commit (celles avec `at <= pairSpreadNow`) et, le cas
  échéant, les entrées non-`success` écartées par la garde de conflit ; les
  entrées futures restent ;
- si `ok: true, written: false` : ne rien retirer et ne rien réinitialiser,
  y compris une entrée écartée par la garde de conflit ; aucune écriture
  réelle n'a eu lieu et l'entrée n'est pas résolue ;
- si `ok: false` : ne rien retirer.

**Pendant la suspension.** Si `probeNow < suspendedUntil`, le scheduler
retourne `{ selected: [], nextCursorKey: cursorKey }` avant toute
sélection ; aucune probe n'est tentée, aucun coût
RPC n'est engagé, `lastGlobalProbeAt` n'est pas mis à jour (aucun batch n'a
été lancé). Le scan normal continue. La suspension est consultée avant le
throttle global et avant le filtre d'intervalle par paire. Le commit du
cycle continue d'avoir lieu : il peut ré-émettre les attempts en attente et,
s'il réussit réellement, lever la suspension par anticipation.

**Reprise et rotation.** À l'expiration de `suspendedUntil`, la sélection
repart. L'historique est reconstruit depuis le Store **et** l'overlay
`pendingAttempts` (D8) : une paire dont la probe n'a pas été persistée n'est
pas immédiatement re-sondée, et les autres candidats passent. Si le commit
suivant retourne `commitSucceeded` :

- `writeFailures = 0` ;
- `suspendedUntil = 0` ;
- les entrées commitées sont retirées de `pendingAttempts` ;
- un événement `pair_spread_probe_recovered` de niveau `info` est émis.

Si le commit échoue encore avec un `WRITE_FAILED`, le backoff double
jusqu'au plafond de 1 h. Un `pendingAttempts` plus ancien ne recule jamais
un `at` plus récent.

**Limite après redémarrage.** `writeFailures`, `suspendedUntil`,
`pendingAttempts` et `cursorKey` ne sont **pas** persistés (aucun changement
de schéma Store v2). Après un redémarrage :

- le backoff est perdu : un nouveau `WRITE_FAILED` repart à 5 min ;
- `pendingAttempts` est vide : une paire dont la probe n'a pas été persistée
  peut être sondée plus tôt que `intervalMs`, et les attempts non écrits
  sont définitivement perdus ;
- `lastGlobalProbeAt = null` : le premier batch est autorisé sans throttle
  global (D6) ;
- `cursorKey = null` : la fairness repart de la première clé (D3).

Cette limite est acceptée : persister ces champs exigerait un changement de
schéma ou un second fichier, hors périmètre (D14). Le redémarrage n'est pas
un mécanisme de récupération ; l'opérateur doit corriger la cause
(permissions, espace disque, système de fichiers) et surveiller l'événement
`pair_spread_probe_write_failed`.

**Justification.** Sans backoff, chaque cycle retenterait des probes dont le
résultat ne peut pas être conservé : coût RPC gaspillé, logs répétés et
rotation faussée. Sans `pendingAttempts`, la même paire repasserait en tête
de file à chaque cycle et affamerait les autres ; sans attempts complets,
elle ne pourrait pas être ré-émise et l'échec d'écriture resterait
définitif. La suspension temporaire laisse le scan normal fonctionner et
évite d'arrêter le processus pour un échec de persistance qui n'affecte pas
l'exécution. Exiger `commitSucceeded` évite de traiter un no-op
`written: false` comme une preuve d'écriture.

**Conséquences.**

- Un `WRITE_FAILED` ne perd pas les attempts pour la rotation du processus
  courant, et les attempts complets sont ré-émis au commit suivant ; les
  samples du cycle sont définitivement perdus. Un attempt non-`success` en
  attente peut être abandonné lorsqu'un sample plus récent est persisté pour
  la même clé (garde de conflit), ce qui est sans effet sur la rotation.
- Un `ok: true, written: false` ne lève pas la suspension et ne vide pas
  `pendingAttempts`. Rien ne garantit qu'une « prochaine écriture réelle »
  survienne : si chaque commit ultérieur est un no-op (état identique,
  aucune entrée expirée à purger), des entrées peuvent rester indéfiniment
  dans l'overlay. C'est notamment le cas d'un attempt non-`success` en
  attente exclu par la garde de conflit parce qu'un sample **survivant**
  existe pour la même clé : le no-op ne le retire pas, et il continue de
  retarder la rotation. La conservation est conservatrice ; elle n'est pas
  une garantie de résolution. Seul `commitSucceeded` retire des entrées.
- Le backoff est indépendant du throttle global : les deux conditions
  s'appliquent.
- Un `WRITE_FAILED` répété ne fait pas croître indéfiniment la mémoire :
  `pendingAttempts` est borné par le nombre de clés observées (une entrée
  par clé, l'attempt de `at` maximal), pas par le nombre de cycles.
- La limite de redémarrage est explicite et couverte par le plan de tests
  D13 ; elle ne doit pas être présentée comme une garantie de rotation après
  incident.

## 6. Options examinées

### 6.1 Contenu d'une probe

| Option | Coût RPC | Comparabilité avec le filtre | Réactivation possible | Verdict |
|---|---|---|---|---|
| **A. `scanPair` complet** | celui d'un scan | identique | oui, fiable | **recommandée** |
| B. Quote de la plus petite taille | faible | biaisée vers le bas | rarement, voire jamais | rejetée |
| C. Réutiliser le dernier résultat de scan | nul | aucune nouvelle observation | non | rejetée |

L'option B est celle suggérée par l'ADR 0006. Elle est séduisante pour le
coût, mais le filtre compare le **meilleur** `netProfitBps` parmi les
tailles. Une quote de la plus petite taille produit un `bps` au plus égal
au meilleur `bps`, et généralement plus bas ; une paire viable pourrait
rester filtrée indéfiniment. L'option C ne produit aucun échantillon
nouveau : elle ne résout pas le blackout.

### 6.2 Ordonnancement

| Option | Chevauchement | Arrêt propre | Complexité | Verdict |
|---|---|---|---|---|
| **A. Scheduler appelé dans le cycle** | impossible (`run.js` attend la fin du cycle) | immédiat | faible | **recommandée** |
| B. Timer dédié (`setInterval`) | possible | nécessite un arrêt dédié | élevée | rejetée |
| C. Probe avant la boucle principale | possible | immédiat | moyenne | rejetée |

L'option C inverserait l'ordre : une probe serait exécutée avant de savoir
si la paire est réellement filtrée, ce qui exige de connaître les décisions
à l'avance ou de risquer un doublon. L'option A est la plus simple et la
plus déterministe.

Quel que soit l'ordonnanceur retenu, un intervalle global strictement
positif est obligatoire dès que `intervalMs > 0` (6.6). Le scheduler reste
appelé une fois par cycle ; l'intervalle global ne crée pas de timer.

### 6.3 Persistance

| Option | Sources de vérité | Migration | Atomicité | Verdict |
|---|---|---|---|---|
| **A. Store v2 existant** | une | aucune | un commit par cycle | **recommandée** |
| B. Fichier `probe_attempts.json` séparé | deux | nouvelle | deux écritures | rejetée |
| C. Aucune persistance | une (mémoire) | aucune | N/A | rejetée |

L'option B recréerait les problèmes de cohérence que l'ADR 0006 a
justement évités avec le Store v2. L'option C perd l'historique à chaque
processus `scan.yml` et rend la rotation dépendante du redémarrage.

### 6.4 Périmètre des paires

| Option | Coût | Bénéfice | Verdict |
|---|---|---|---|
| **A. Paires filtrées en `enforce`** | borné par le blackout | direct | **recommandée** |
| B. Toutes les paires | double le scan | aucun | rejetée |
| C. Paires filtrées + `shadow` | double le scan en shadow | aucun (shadow scanne déjà) | rejetée |

### 6.5 Réactivation

| Option | Coût | Délai | Verdict |
|---|---|---|---|
| **A. Cycle suivant, via la règle D5 de l'ADR 0006** | nul | un cycle | **recommandée** |
| B. Rescan immédiat dans le même cycle | double le coût | immédiat | rejetée |
| C. Exiger N probes consécutives au-dessus du plancher | N cycles | plus lent | rejetée |

L'option B annule l'économie de la probe et complique l'ordre des
observations. L'option C invente un second critère de réactivation et
retarde la récupération sans preuve.

Un sample de probe sous le plancher ne peut jamais déclencher
`LAST_AT_OR_ABOVE_FLOOR` : `lastBelowFloor` reste vrai. Il ne peut réactiver
que par `MEDIAN_AT_OR_ABOVE_FLOOR`, si la médiane de la fenêtre passe au
niveau du plancher, y compris par éviction d'un ancien échantillon plus bas.
Ce n'est pas une option d'ordonnancement ; c'est une conséquence de la règle
D5 de l'ADR 0006, documentée pour éviter une lecture absolue erronée.

### 6.6 Intervalle global : obligatoire ou optionnel ?

| Option | Comportement | Risque | Verdict |
|---|---|---|---|
| **A. `globalIntervalMs > 0` obligatoire si `intervalMs > 0`** | borne inter-batchs | configuration supplémentaire | **recommandée** |
| B. `0` = pas de throttle même avec probes actives | rafale toutes les 15 s | coût RPC non borné | rejetée |
| C. `0` = hériter de `intervalMs` | un batch par heure | rotation trop lente | rejetée |

L'option B est le comportement du scheduler pur, utile aux tests, mais pas
une configuration d'activation : avec `run.js` à 15 s et `M = 10`, elle
autorise jusqu'à 57 600 probes/jour. L'option C rend la cible
nominale `minSamples` inatteignable en rotation régulière : avec
`intervalMs = 1 h`, `N = 20`, `M = 1`, un batch par heure donne une paire
toutes les 20 h, soit au plus 2 échantillons en 24 h si les 20 paires
restent candidates. Ce n'est pas une impossibilité démontrable :
`N_candidates` peut être plus faible.
L'option A retient `0` comme « pas de throttle » uniquement au niveau du
scheduler pur ; la validation de configuration refuse `0` dès que
`intervalMs > 0` (D12). La valeur d'activation recommandée est `300000`.

### 6.7 Panne d'écriture : ignorer, arrêter ou suspendre ?

| Option | Coût RPC | Disponibilité | Rotation | Verdict |
|---|---|---|---|---|
| **A. Backoff + `pendingAttempts` + suspension** | borné | cycle maintenu | préservée en mémoire | **recommandée** |
| B. Ignorer et continuer | non borné | cycle maintenu | faussée (même paire en tête) | rejetée |
| C. Arrêter le processus | nul | arrêtée | N/A | rejetée |

L'option B gaspille le RPC et répète les mêmes échecs. L'option C
transforme un incident de persistance en arrêt de service, alors que le scan
normal reste sain. L'option A borne les tentatives, conserve la rotation du
processus courant et documente la perte au redémarrage (D15).

## 7. Arbitrages rendus

Les arbitrages A1–A17 ont été rendus le 2026-11-23. Ils portent sur le
document et sur la base d'implémentation ; à cette date, ils ne validaient
ni le prototype `bot/pairSpreadProbe.js`, ni un comportement testé, et aucun
code ni test n'avait été modifié pour les appliquer. Depuis, l'implémentation
T1–T5 et les tests D13 sont présents dans l'arbre de travail, non commités ;
la validation opérationnelle reste à effectuer.

| ID | Question | Arbitrage rendu | Conséquence |
|---|---|---|---|
| A1 | Cet ADR est-il accepté comme base d'implémentation ? | **oui**, corrections documentaires appliquées ; implémentation T1–T5 et tests D13 présents dans l'arbre de travail, non commités | le document reste la base acceptée ; validation opérationnelle non effectuée |
| A2 | Les probes doivent-elles être activées par défaut ? | **non** : `intervalMs = 0` | aucune probe sans configuration explicite |
| A3 | Quelle valeur d'`intervalMs` à l'activation ? | `3600000` ms (1 h) comme point de départ | rotation initiale lente mais mesurable |
| A4 | Que signifie `globalIntervalMs = 0` ? | **pas de throttle au niveau pur** ; interdit dès que `intervalMs > 0` ; `300000` ms à l'activation | pas d'héritage implicite de l'intervalle par paire |
| A5 | La borne `maxPerCycle <= 10` est-elle acceptée ? | oui, plafond dur ; profil initial `1` | rafale RPC bornée |
| A6 | Quel critère de capacité retenir ? | `R_nom = max(intervalMs, ceil(N_config/M) × G)` ; `minSamples × R_nom > maxAgeMs` → `PROBE_CAPACITY_MARGIN` ; `pairCount` sentinelle (`undefined`/`null`) ou `0` → `PROBE_CAPACITY_INDETERMINATE`, valeur fournie hors domaine → erreur de validation ; aucun `IMPOSSIBLE` ; métriques runtime avant validation `enforce` | indicateurs nominaux, pas de preuve de capacité |
| A7 | Faut-il sonder si l'état n'est pas inscriptible ? | **non** : état invalide ou `loaded.writable !== true` → aucune probe ; `writable: true` n'est pas une preuve de persistance | RPC non gaspillé, résultats non perdus |
| A8 | La réactivation attend-elle le cycle suivant ? | **oui** | pas de double scan dans le cycle |
| A9 | Le plafond de 20 attempts reste-t-il partagé ? | oui, entre scans et probes | pas de second plafond ni de champ `source` sur les samples |
| A10 | Faut-il activer dans `scan.yml` avant `run.js` ? | **non** : commencer par `run.js` ; `scan.yml` exige la persistance du Store et une durée sous 15 min | mesures non trompeuses |
| A11 | Le nom `PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS` est-il retenu ? | oui | nommage cohérent |
| A12 | Faut-il un champ `source` sur les samples ? | **non** ; `source` reste sur les attempts | pas de migration de schéma |
| A13 | Faut-il conserver `intervalMs <= maxAgeMs / minSamples` ? | oui, comme **marge opérationnelle**, pas comme condition nécessaire | pas de fausse preuve d'impossibilité |
| A14 | Faut-il persister `lastGlobalProbeAt` ? | **non** ; état de processus | pas de changement de schéma |
| A15 | Comment traiter un `WRITE_FAILED` ? | backoff 5/10/20/40/60 min (plafonds de suspension) ; récupération anticipée seulement sur `ok && written` ; `ok: true, written: false` ne lève jamais et ne retire jamais ; après un `WRITE_FAILED`, toutes les probes commencées sont résolues et le curseur avance ; exception inattendue, exception de validation/conflit et refus retourné distincts ; le refus déterministe est reconnu par un `error.code` Store stable (à implémenter) valant exactement `PAIR_SPREAD_STATE_VALIDATION_FAILED` ou `PAIR_SPREAD_STATE_CONFLICT`, jamais par `instanceof`, un `tag` ou le message ; `pendingAttempts` fusionnés sur exception inattendue, pas sur refus déterministe | RPC borné, rotation préservée en mémoire, pas de faux succès, pas de clé bloquée par l'échec d'écriture |
| A16 | La validation dépend-elle du mode ? | **non** : mêmes types, bornes et couplage en `off`, `shadow` et `enforce` | configuration invalide détectée tôt |
| A17 | Comment garantir la fairness ? | curseur circulaire en mémoire, ordre lexicographique, toutes les clés uniques conservées et éligibilité marquée sans retrait ; départ à la clé immédiatement suivante si `cursorKey` est présent, sinon à la première clé lexicale ; un tour complet ne répète aucune clé ; `nextCursorKey` = dernière clé examinée ; ne dépasse aucune clé sélectionnée non résolue (les clés résolues et les clés non sélectionnées peuvent être dépassées) ; une clé exclue par D5 est résolue ; après un `WRITE_FAILED`, les probes commencées sont résolues et le curseur avance ; seules les clés sélectionnées non commencées après une annulation restent devant le curseur ; tests N=3/M=2 et N=5/M=2 | famine réduite dans un processus, non garantie après redémarrage |

**Justification de A3.** Pour une paire sans délai de rotation, avec
`minSamples = 5` et `maxAgeMs = 24 h`, un intervalle d'une heure donne cinq
échantillons dont le premier et le dernier sont séparés de 4 h, soit une
marge de 6× sur la fenêtre. La marge de validation utilise
`minSamples × intervalMs = 5 h`, soit 4,8×. Avec 20 candidats et un
intervalle global de 5 min, la rotation **nominale** est d'environ 100 min :
le premier et le dernier de cinq échantillons seraient alors séparés
d'environ 6 h 40, ce qui reste sous 24 h, et l'intervalle de 1 h n'est pas
contraignant. Ce n'est pas une garantie. Avec peu de candidats, l'intervalle
de 1 h évite de sonder la même paire toutes les 5 min.

**Justification de A4.** Si `0` signifiait « hériter de l'intervalle par
paire », un intervalle d'une heure imposerait un batch par heure, soit au
plus 24 batches par jour, et une paire parmi 20 ne serait sondée qu'une
fois toutes les 20 h en rotation nominale : la cible `minSamples` ne serait
pas atteinte en 24 h si les 20 paires restent candidates. Ce n'est pas une
impossibilité démontrable : `N_candidates` peut être plus faible. C'est
pourquoi l'arbitrage retient « `0` = pas de throttle global » au niveau du
scheduler pur, avec une valeur explicite à l'activation et un refus de `0`
dès que `intervalMs > 0`.

**Justification de A5.** `maxPerCycle = 10` est un plafond de sécurité, pas
une cible. Le profil initial `1` limite la première activation à une probe
par cycle pour mesurer le coût RPC et la latence avant toute augmentation.

**Justification de A6.** L'ancienne formule `N × global × minSamples > maxAge`
n'est pas retenue : elle suppose implicitement `M = 1` et ne distingue pas
la marge nominale d'une preuve. Le critère retenu est un **avertissement
nominal** fondé sur `R_nom = max(intervalMs, ceil(N_config/M) × G)` et
`minSamples × R_nom > maxAgeMs`. Il ne prouve pas qu'une paire ne peut pas
recevoir `minSamples` échantillons : `N_candidates(t)` peut être inférieur à
`N_config`, les batchs peuvent être plus lents que `G`, et `p < 1` réduit les
samples. La seule impossibilité démontrable,
`(minSamples - 1) × intervalMs > maxAgeMs` dans la fenêtre fermée, est déjà
exclue par la validation D12. `PROBE_CAPACITY_INDETERMINATE` couvre le cas
où `pairCount` est absent, `null` ou nul ; aucun
`PROBE_CAPACITY_IMPOSSIBLE` n'est émis. Aucun seuil numérique de capacité
runtime n'est fixé par cet ADR : les métriques
doivent être collectées avant de considérer l'activation en `enforce` comme
validée.

**Justification de A7.** `loaded.writable` est une indication calculée au
chargement, pas une garantie que l'écriture suivante réussira. Sonder un
état invalide ou déclaré non inscriptible gaspille le RPC et produit des
samples qui ne peuvent pas être conservés. La preuve réelle reste le commit
(D10, D15).

**Justification de A10.** `scan.yml` ne persiste que `logs/scans.jsonl` :
`logs/pair_spreads.json` ne survit pas d'un run à l'autre
(`.github/workflows/scan.yml:55-63`). Il a aussi `timeout-minutes: 15` et
`cancel-in-progress: true` (`:17-27`). L'activation initiale doit donc se
faire dans `run.js`, où le Store est persistant, où `lastGlobalProbeAt`
survit entre cycles et où les cycles ne se chevauchent pas.

**Justification de A13.** La seule impossibilité démontrable dans la fenêtre
fermée est `(minSamples - 1) × intervalMs > maxAgeMs`. La borne
`intervalMs <= maxAgeMs / minSamples` est plus stricte : elle conserve une
marge opérationnelle sans prétendre garantir la rotation.

**Justification de A14.** Persister `lastGlobalProbeAt` exigerait un
changement de schéma ou un second fichier d'état, hors périmètre (D14). Le
prix est un premier batch autorisé sans throttle global après chaque
redémarrage, ce qui est borné par `maxPerCycle`.

**Justification de A15.** Sans backoff, chaque cycle retente des probes dont
le résultat ne peut pas être écrit ; sans `pendingAttempts`, la même paire
repasse en tête de rotation. Les attempts doivent être complets pour être
ré-émis : un simple `at` ne satisfait pas le schéma du Store. Seul
`commitSucceeded` (`ok && written`) prouve l'écriture ; `written: false`
laisse l'overlay intact, sans garantie qu'une écriture ultérieure le
résolve. Une exception de commit sans `error.code` déterministe reconnu est
inattendue : l'issue est inconnue, donc les attempts sont conservés en
mémoire et aucun backoff n'est armé. Une exception de validation ou un
conflit Store n'est déterministe que si elle porte un `error.code` Store stable
(mécanisme à implémenter) ; dans ce cas seulement, les attempts du cycle ne
sont pas fusionnés, sinon l'overlay rejouerait le même refus. Un refus
retourné non-`WRITE_FAILED` n'est pas fusionné non plus. Le backoff et
l'overlay sont en mémoire, donc perdus au redémarrage : c'est une limite
documentée, pas une garantie de rotation après incident.

**Justification de A17.** L'ancien tri par `lastAt` puis clé du prototype
favorisait les clés basses à timestamp égal et pouvait affamer une clé haute
quand de nouvelles clés apparaissaient. Le curseur circulaire supprime ce
biais dans un processus donné. Il ne dépasse aucune clé sélectionnée
**non résolue** : une telle clé reste devant le curseur et est
resélectionnée. Il peut dépasser les clés sélectionnées **résolues**
(commencées ou explicitement exclues par D5) ainsi que les clés non
sélectionnées ; une clé exclue par D5 est résolue et peut être dépassée. Il
n'est pas persisté :
la fairness n'est pas garantie après un redémarrage ni entre deux runs
`scan.yml`. C'est une amélioration déterministe et testable, pas une garantie
de période maximale.

**Justification de A16.** La validation fail-fast évite qu'une configuration
« de test » doive être corrigée au moment du passage en `enforce`. Une
chaîne vide `""` utilise le défaut ; une chaîne d'espaces est une erreur
explicite, jamais `0`.

## 8. Fichiers concernés par l'implémentation

Cette liste décrit les fichiers de l'implémentation T1–T5, présente dans
l'arbre de travail mais non commitée. Ces modifications ne sont pas
attribuées à l'ADR lui-même.

| Fichier | Nature du changement | Risque |
|---|---|---|
| `bot/pairSpreadProbe.js` | `initProbeHistoryFromState(state)` : samples + attempts persistés uniquement, `max(at)` par clé, ne lit pas `pendingAttempts` ; `selectProbeCandidates({ candidates, scannedKeys, probedKeys, history, pendingAttempts, pairSpreadNow, probeNow, intervalMs, globalIntervalMs, lastGlobalProbeAt, suspendedUntil, maxPerCycle, cursorKey })` → `{ selected: [{ key, pair, lastAt }], nextCursorKey }` : validation des requis/optionnels, sentinelles et éléments de `candidates` (`null`, non-objet, tableau, `pair` invalide = erreur ; clé invalide = ignorée sans valider `pair`), filtre des clés vides, `intervalMs = 0 → selected = []`, overlay `max(history, pendingAttempts)`, éligibilité sur `pairSpreadNow`, throttle/suspension sur `probeNow`, exclusion D5 avant sélection, conservation de toutes les clés uniques, tri lexicographique, éligibilité marquée sans retrait, parcours circulaire sans répétition à partir de la clé immédiatement suivante si `cursorKey` est présent sinon de la première clé lexicale, `nextCursorKey` = dernière clé examinée, `maxPerCycle <= 10`, curseur qui ne dépasse aucune clé sélectionnée non résolue (clé D5 exclue = résolue) ; `recordProbeAttempt` ; helpers de throttle et de fusion d'overlay | moyen : logique de sélection |
| `bot/config.js` | `PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS`, lecteur `optionalProbeInteger`, bornes, couplage, `pairCount` et avertissements de capacité (`MARGIN`, `INDETERMINATE`), propagation via `validateScannerConfig` | moyen : validation au démarrage |
| `.env.example` | documente les trois variables `PAIR_SPREAD_PROBE_*` et leurs valeurs par défaut ; il ne les active pas à lui seul | faible |
| `bot/index.js` | `resolvePairSpreadSettings` expose les trois réglages ; runtime `{ lastGlobalProbeAt, writeFailures, suspendedUntil, pendingAttempts, cursorKey }` ; `scannedKeys`, `probedKeys`, `pairSpreadNow`, `probeNow` ; collecte des paires filtrées ; phase de probe après la boucle ; logging/classification non bloquants (D9) avec un événement `pair_spread_probe` par probe commencée (`debug` pour `success`/`empty`, `warn` pour `failure`) ; `lastGlobalProbeAt` reçoit le `probeNow` capturé au début de la phase, pas l'heure réelle du wrapper ; curseur runtime : après un `WRITE_FAILED`, toutes les probes commencées sont résolues et le curseur avance, seules les clés sélectionnées non commencées après une annulation restent devant lui ; `commitSucceeded`, fusion et ré-émission des attempts en attente, exception inattendue, refus déterministe par `error.code` et refus retourné distincts de `WRITE_FAILED` (D15) ; commit unique | élevé : cœur du cycle |
| `bot/pairSpread.js` | aucun changement attendu : `decidePairSpread`, `bestNetProfitBps` et `buildPairKey` restent les autorités | faible |
| `bot/pairSpreadStore.js` | aucun changement de schéma ; vérifier `source: "probe"`, la déduplication des samples par `at`/valeur max, celle des attempts par tuple et la forme `WRITE_FAILED` ; ajouter `error.code` avec les valeurs exactes `PAIR_SPREAD_STATE_VALIDATION_FAILED` et `PAIR_SPREAD_STATE_CONFLICT` pour les refus déterministes (validation/conflit) requis par D15 | faible |
| `bot/run.js` | aucun changement : fournit la non-superposition et la persistance du processus | faible |
| `.github/workflows/scan.yml` | aucun changement dans cet ADR ; activation initiale dans `run.js` ; persistance du Store requise avant activation ici | faible |
| `test/BotPairSpreadProbe.test.js` | étendre les tests unitaires : M1, D3 (contrat complet requis/optionnels/sentinelles, validation des éléments de `candidates`, forme `{ key, pair, lastAt }`, filtre des clés vides, `intervalMs = 0`, `maxPerCycle` 1–10, départ après `cursorKey` présent sinon première clé lexicale, tour complet sans répétition, `nextCursorKey` = dernière clé examinée, wrap, batch vide, N=3/M=2, N=5/M=2, annulations), D5, D7, D8, `pairSpreadNow`/`probeNow`, overlay de sélection, logging/classification avec niveaux `debug` (`success`, `empty`) et `warn` (`failure`) de `pair_spread_probe` ; ne pas conserver les assertions de tri `lastAt` ni l'ancienne forme de retour. Le backoff, la ré-émission `pendingAttempts`, le curseur après `WRITE_FAILED` et `commitSucceeded` relèvent de l'intégration | moyen |
| `test/ValidatePairSpreadProbeConfig.test.js` | défauts, bornes, `maxPerCycle = 11`, chaînes, modes, `pairCount`, `MARGIN`/`INDETERMINATE`, couplage global | moyen |
| `test/BotPairSpreadProbeIntegration.test.js` | nouveau : cycle complet, `pairSpreadNow`/`probeNow` (dont `lastGlobalProbeAt` = `probeNow` capturé, pas l'heure réelle), erreurs, `probe_scheduler_error`, `pair_spread_probe_history_error`, réactivation, curseur et annulations, curseur après `WRITE_FAILED` (probes commencées résolues, curseur avancé), panne d'écriture, backoff/overlay D15, ré-émission, `commitSucceeded`, exception inattendue, refus déterministe par `error.code`, refus retourné, logging/classification avec niveaux `debug` (`success`, `empty`) et `warn` (`failure`), `written:false` no-op avec overlay, redémarrage | élevé |
| `test/BotPairSpreadStore.test.js` | régression `source: "probe"`, plafond, conflit, `WRITE_FAILED`, déduplication, `error.code` stable des refus déterministes (`PAIR_SPREAD_STATE_VALIDATION_FAILED`, `PAIR_SPREAD_STATE_CONFLICT`) | faible |
| `bot/ARCHITECTURE.md` | amendement D14 : `scannedKeys ∩ probedKeys = ∅`, probe sans effets métier, curseur et clés sélectionnées non résolues, clé D5 exclue résolue, après `WRITE_FAILED` toutes les probes commencées sont résolues et le curseur avance, logging/classification, exceptions de commit inattendues et refus déterministes par `error.code` stable, état de processus non persisté | faible |
| `docs/PRIORITES.md` | statut après implémentation | faible |

Les tests listés sont présents dans l'arbre de travail, non commités ; leur
exécution relève de la mission d'implémentation, pas de l'ADR.

`docs/adr/0006-pair-spread-filter.md` n'est **pas** dans cette liste : il
ne doit pas être modifié.

`bot/pairSpreadProbe.js` reste pur : il ne lit ni l'environnement, ni le
Store, ni l'horloge, ni le système de fichiers ; toutes ses entrées sont des
paramètres ; il ne mute ni `state`, ni `history`, ni `pendingAttempts` ; il
retourne un nouvel objet. `pairSpreadNow`, `probeNow`, `lastGlobalProbeAt`,
`pendingAttempts`, `suspendedUntil` et `cursorKey` lui sont passés par
l'appelant.

## 9. Risques résiduels et conditions de réexamen

### 9.1 Risques résiduels

- **Coût RPC.** Une probe coûte un scan complet. L'intervalle global
  obligatoire et `maxPerCycle <= 10` bornent la cadence des batchs `B` et le
  nombre de probes `P`, mais pas directement les requêtes `Q` : `q` dépend
  de `tradeSizes.length`, qui n'a pas de borne supérieure explicite. Le
  budget est un modèle, pas une mesure.
- **Latence du cycle.** Les probes allongent `D_i` ; `run.js` ne chevauche
  pas les cycles, donc la cadence effective baisse et les batchs s'espacent
  au-delà de `G`.
- **Quotes périmées.** Une probe tardive peut produire `QUOTE_STALE` ;
  elle est classée `empty`, pas `failure`, mais elle ne rafraîchit pas
  l'historique.
- **Absence de verrou inter-process.** Deux processus `scan.yml` simultanés
  pourraient écrire le Store ; c'est une limite connue de l'ADR 0006, non
  résolue ici.
- **Dérive d'horloge.** L'éligibilité par paire utilise `pairSpreadNow`, la
  même horloge que les `at` ; le throttle global et la suspension utilisent
  `probeNow`. Un `at` futur est exclu de la sélection ; un `at` très en
  avance peut retarder une paire. Une horloge qui recule bloque le batch
  global (`probeNow < lastGlobalProbeAt`) et peut rendre un attempt de
  l'overlay futur par rapport à `pairSpreadNow`, ce qui le maintient en
  attente.
- **Plafond partagé.** Les probes peuvent évincer d'anciens attempts de
  scan ; seul le plus récent compte, donc l'impact est limité.
- **Intervalle global en mémoire.** Dans `scan.yml`, il ne borne pas entre
  processus ; le cron reste la borne réelle. Ce mode n'est pas retenu pour
  l'activation initiale (D6).
- **Nombre de candidats.** Avec `G = 300000`, `M = 1` et les autres
  défauts, au-delà de 57 candidats la marge nominale
  `minSamples × R_nom <= maxAgeMs` n'est plus satisfaite. Avec `M = 10`, le
  seuil nominal passe à 571, mais l'intervalle par paire peut borner avant.
  `N_config` est une borne supérieure : le nombre réel de paires filtrées
  peut être plus faible. Aucun de ces seuils ne prouve une impossibilité.
- **Fairness non persistante.** Le curseur est en mémoire : après un
  redémarrage ou entre deux runs `scan.yml`, la rotation repart de la
  première clé et une clé basse et ancienne peut être favorisée. Aucune
  période maximale par paire n'est garantie, même avec le curseur.
- **Marge de validation non garante.** `intervalMs <= maxAgeMs / minSamples`
  est une marge opérationnelle plus stricte que la condition nécessaire,
  pas une preuve de rotation. La seule impossibilité démontrable,
  `(minSamples - 1) × intervalMs > maxAgeMs`, est déjà exclue par cette
  borne.
- **Biais du maximum.** Les samples restent des maxima parmi les tailles,
  comme pour les scans ; l'ADR 0006 le documente déjà.
- **Échecs invisibles dans les compteurs.** C'est volontaire (D9), mais
  cela signifie qu'un taux d'échec de probe élevé ne se voit que dans les
  logs et les attempts.
- **Panne d'écriture.** Un `WRITE_FAILED` perd les samples du cycle et
  suspend les probes jusqu'à 1 h. Les attempts complets sont conservés et
  ré-émis, mais un `ok: true, written: false` ne prouve pas l'écriture et ne
  lève pas la suspension. Le backoff, `pendingAttempts` et le curseur sont en
  mémoire : un redémarrage les perd et peut sonder une paire plus tôt que
  `intervalMs` (D15).
- **Exception de commit inattendue.** L'issue d'une écriture qui lève est
  inconnue. Les attempts du cycle sont conservés dans `pendingAttempts` et
  rejoués au cycle suivant, mais un sample non écrit est perdu :
  `pendingAttempts` ne conserve que les attempts. Le Store déduplique les
  samples par `at` et les attempts par tuple, donc la ré-émission des
  attempts est idempotente ; elle ne reconstitue pas un sample perdu. Aucun
  backoff n'est armé : une exception répétée peut donc retenter à chaque
  cycle.
- **Exception de validation ou conflit.** Un refus déterministe levé avant
  écriture (validation des arguments ou des entrées, conflit
  sample/attempt non-`success`) doit être reconnu par un **`error.code` Store
  stable** (mécanisme à implémenter, D15), jamais par `instanceof`. Un tel
  refus n'arme pas le backoff et ne fusionne pas les attempts du cycle ; le
  conflit est levé par le Store, pas retourné en `ok: false`. Les attempts
  de ce cycle sont perdus pour la rotation, et la même paire peut être
  re-sondée plus tôt que prévu après correction. Une exception sans
  `error.code` reconnu est classée inattendue : elle fusionne les attempts du
  cycle dans `pendingAttempts` (D15).
- **Refus déterministe retourné.** Un `ok: false` autre que `WRITE_FAILED`
  (`CORRUPT`, `SCHEMA_INVALID`, `UNREADABLE`, version inconnue,
  `writable: false`) n'arme pas le backoff et ne fusionne pas les attempts du
  cycle. Les probes sont désactivées au chargement suivant si l'état reste
  non inscriptible.
- **Curseur et annulation.** Une clé sélectionnée, non commencée et non
  résolue reste avant le curseur et sera resélectionnée ; une clé exclue par
  D5 est résolue sans être commencée et peut être dépassée. Une annulation
  répétée au même point peut donc retarder les clés suivantes sans les
  sauter, mais ne bloque pas une clé déjà résolue. Le curseur n'offre pas de
  borne de temps.
- **Curseur après `WRITE_FAILED`.** Un échec d'écriture n'est pas une
  annulation : il survient au commit, après la boucle de probe, donc toutes
  les probes commencées sont résolues et le curseur avance. Seules les clés
  sélectionnées mais non commencées à la suite d'une **annulation** restent
  devant le curseur. Si l'implémentation traite un `WRITE_FAILED` comme une
  annulation, elle bloque indûment les clés suivantes ; si elle l'ignore
  pour les probes commencées, elle peut les re-sélectionner à tort. Le cas
  est couvert par D13 et doit rester explicite dans l'amendement de
  `bot/ARCHITECTURE.md`.
- **Logging et classification.** Une exception de classification perd le
  sample et laisse un attempt non-`success` : la paire peut rester filtrée
  plus longtemps. Une exception de logging est sans effet sur l'outcome,
  mais peut masquer l'événement.
- **Avertissements au démarrage seulement.** Les seuils de capacité ne sont
  pas recalculés à chaud ; un changement de `minSamples`, `maxAgeMs` ou du
  nombre de paires exige un redémarrage. `PROBE_CAPACITY_INDETERMINATE`
  signale seulement un `pairCount` absent, `null` ou nul, pas une capacité
  mesurée.
- **Validation fail-fast.** Une configuration valide en `off`/`shadow` peut
  être refusée si elle serait invalide en `enforce` ; c'est voulu, mais cela
  peut surprendre lors d'un test.

### 9.2 Conditions de réexamen

1. Après une période d'observation, si le coût RPC ou la latence dépasse
   le budget → revoir `maxPerCycle`, `globalIntervalMs` ou le contenu de
   la probe.
2. Si des paires ne sont jamais sondées (famine) → revoir le curseur, le
   plafond de 20 attempts, `pendingAttempts` ou le nombre de candidats.
3. Si une probe réactive une paire à tort → revoir D4 et la comparabilité
   des samples.
4. Si `maxAgeMs`, `minSamples` ou `windowSize` changent → revoir les
   bornes de D12 et les seuils de capacité D7.
5. Si la cadence passe de `scan.yml` à `run.js` ou inversement → revoir
   D6 et D7 ; `scan.yml` exige la persistance du Store et une durée sous
   15 min.
6. Si le schéma du Store change → rouvrir D10, D11 et D15.
7. Si le multi-hop ou un mode par paire est implémenté → rouvrir D1, D3
   et D10.
8. Si `pair.minProfitBps` devient mutable ou adaptatif → rouvrir D4.
9. Si le taux de `WRITE_FAILED` est élevé ou si le backoff de 1 h est trop
   long/court → revoir D15 (base, plafond, suspension, distinction avec les
   exceptions et les refus déterministes).
10. Si un redémarrage pendant une panne d'écriture provoque une rotation
    incorrecte → rouvrir la persistance de `pendingAttempts` (changement de
    schéma hors périmètre actuel).
11. Si les probes doivent être activées dans `scan.yml` → ajouter la
    persistance/restauration de `pair_spreads.json` et vérifier le timeout
    de 15 min et `cancel-in-progress`.
12. Si les avertissements de capacité sont trop pessimistes ou trop
    silencieux → comparer `pairCount` au nombre réel de paires filtrées et
    au taux de succès mesuré, puis revoir D7.
13. Si l'écart `probeNow - pairSpreadNow` varie anormalement → revoir D11
    et la mesure de durée des cycles ; il n'affecte pas l'éligibilité par
    paire, mais il peut fausser le throttle global et la suspension.
14. Si les exceptions de commit inattendues se répètent ou si l'issue d'une
    écriture interrompue reste ambiguë → revoir la stratégie de fusion D15 et
    la granularité du commit.
15. Si une exception de validation ou un conflit Store **reconnu par un
    `error.code` stable** survient alors que des probes sont actives → revoir
    D10/D15 : ne pas fusionner les attempts du cycle, corriger la cause et
    vérifier le rechargement. Une exception sans `error.code` reconnu reste
    inattendue et suit la règle de fusion D15.
16. Si une annulation répétée retarde les clés non commencées → revoir D3
    et A17 (point de départ, annulation avant et après le premier appel).
17. Si les erreurs de logging ou de classification sont fréquentes → revoir
    D9 et la journalisation.

## 10. Références

- Décisions internes : D3 (contrat du scheduler), D9
  (logging/classification), D13 (plan de tests), D15 (panne d'écriture) ;
  arbitrages A1–A17 (section 7).
- `docs/adr/0006-pair-spread-filter.md` — décisions D1–D15, règle D5
  (`:378`), limite connue n° 3 (`:1054-1060`), condition de réexamen n° 8
  (`:1094-1095`).
- `bot/pairSpreadProbe.js` — module pur (implémentation T1–T5),
  `initProbeHistoryFromState` (`:52-89`), `selectProbeCandidates`
  (`:99-152`), `recordProbeAttempt` (`:158-173`),
  `validateProbeMaxPerCycle` (`:20-25`).
- `bot/pairSpread.js` — `buildPairKey` (`:81-108`), `bestNetProfitBps`
  (`:146-164`), `decidePairSpread` (`:297-374`).
- `bot/pairSpreadStore.js` — Store v2, `MAX_ATTEMPTS_PER_PAIR` (`:22`),
  sources (`:36`), déduplication des samples (`:199-202`), sample futur
  (`:605`), attempt futur (`:630`), conflit sample/attempt (`:791-801`),
  garde d'écriture (`:919-930`), `WRITE_FAILED` (`:958-982`).
- `bot/index.js` — `resolvePairSpreadSettings` (`:132-146`),
  `pairSpreadNow` (`:258`), chargement de l'état (`:261-302`), skip
  `enforce` (`:430-440`), attempts de scan (`:462-499`), commit unique
  (`:587-626`), `exitCode` (`:646-654`).
- `bot/config.js` — `validatePairSpreadSettings` (`:60-118`), défauts de
  probe (`:446-447`), réglages `PAIR_SPREAD_*` (`:669-679`), propagation
  (`:692-720`).
- `bot/run.js` — `DEFAULT_POLL_INTERVAL_MS = 15000` (`:6`), absence de
  chevauchement (`:111-127`).
- `bot/scanner.js` — `scanPair` (`:257-377`), `QUOTE_STALE` (`:319-327`).
- `.github/workflows/scan.yml` — cron `*/5 * * * *` (`:12-13`),
  `concurrency.cancel-in-progress` (`:17-20`), `timeout-minutes: 15`
  (`:27`), upload de `logs/scans.jsonl` (`:55-63`).
- `bot/ARCHITECTURE.md` — invariant pair-spread (`:213-233`), exit code
  d'un cycle filtré (`:234-239`).
- `test/BotPairSpreadProbe.test.js`, `test/ValidatePairSpreadProbeConfig.test.js`
  et `test/BotPairSpreadProbeIntegration.test.js` — tests unitaires et
  d'intégration présents dans l'arbre de travail, non commités.

---

*Fin de l'ADR 0007. Les décisions D1–D15, les arbitrages A1–A17 et les
corrections F1–F11, y compris la correction F8 (contrat de journalisation
`debug`/`debug`/`warn`), sont acceptés comme base d'implémentation au
2026-11-23. L'implémentation T1–T5 et les tests D13 sont présents dans
l'arbre de travail, non commités ; la validation opérationnelle reste à
effectuer et les probes demeurent désactivées par défaut.*
