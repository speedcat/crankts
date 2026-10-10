Nach MVP-9a macht MVP-9b **keinen Sinn mehr als „CrankTS optimiert sich selbst“**. Deine Messung hat diese Hypothese ziemlich sauber falsifiziert:

- WCC + Tarjan + Island-Analyse zusammen ~20 ms von ~5,9 s.
- Tarjan selbst ~4 ms.
- Selbst wenn die Graph-Pässe kostenlos wären, gewinnst du <1 %.
- CrankTS empfiehlt seinen eigenen Graph-Code folgerichtig `KEEP_TS`.
- 71,8 % der CPU-Leaf-Time liegt im TypeScript-Paket, weitere 12,4 % in GC.

Das ist eigentlich ein **gutes Ergebnis für CrankTS**, nur kein guter Self-Offload-Case. Der Analyzer sagt eben nicht reflexartig „Rust!“, sondern erkennt: *Hier lohnt es sich nicht.*

## Wofür MVP-9b trotzdem sinnvoll ist

Als **Backend-/Transformationstest für den `GRAPH_BATCH`-Shape**.

Also nicht:

> „Kann CrankTS sich mit Rust beschleunigen?“

sondern:

> „Kann CrankTS einen graphbasierten, statisch geeigneten Kernel deterministisch lowern, und erzeugt das Native-Backend für hinreichend große Inputs tatsächlich einen schnelleren Kernel?“

W3 wäre damit ein kontrollierter Skalierungstest:

```text
real CrankTS graph representation
          ↓
replay at increasing scale
          ↓
TS Tarjan/WCC
vs.
native Tarjan/WCC
```

Beispielsweise:

```text
1× real graph
2×
5×
10×
25×
```

und messen:

```text
nodes / edges
TS kernel
native kernel
transfer/preparation
total native call
RSS
crossover point
```

Das kann eine sehr wichtige Frage beantworten:

> **Ab welcher Datenmenge lohnt sich `GRAPH_BATCH` überhaupt?**

Genau diese Information braucht der Advisor später.

Vielleicht kommt heraus:

```text
4k funcs       TS faster
20k funcs      equal
50k funcs      native 1.8×
200k funcs     native 4.2×
```

Dann hat CrankTS daraus eine mechanistische Regel gewonnen:

```text
GRAPH_BATCH offload:
  don't recommend below approximately X work units
```

Das wäre wertvoll.

---

# Aber ich würde MVP-9b nicht zu groß machen

Keine weitere große Rust-Integration.

Ein kleines Harness genügt:

1. bestehende CrankTS-Graphrepräsentation serialisieren,
2. Tarjan/WCC einmal in Rust implementieren,
3. exakt dieselben Ergebnisse vergleichen,
4. Größen skalieren,
5. Crossover messen.

Wenn der Native-Kernel selbst bei großen Graphen kaum gewinnt: **abbrechen und als negatives Ergebnis dokumentieren.**

Wenn er deutlich gewinnt: `GRAPH_BATCH` ist als zweiter Transformations-Shape bestätigt.

Das ist vielleicht 1 kleiner Meilenstein, nicht der nächste große Produkt-Sprint.

---

# Danach würde ich CrankTS-Selfoffload beenden

Das ist mir wichtig.

Nicht versuchen, künstlich einen CrankTS-Hotspot zu erzeugen, nur damit CrankTS sich selbst optimieren kann.

Die viel bessere Story ist eigentlich:

> **CrankTS analyzed itself and correctly decided not to native-offload itself.**

Das ist extrem glaubwürdig.

Sogar als README-Beispiel:

```text
IntentWeave KWX:
NATIVE_OFFLOAD → validated benefit

CrankTS:
KEEP_TS → TypeScript compiler dominates;
native graph offload cannot materially improve wall time
```

Das beweist stärker, dass dein Advisor nicht einfach Native-Offload bevorzugt.

---

# Danach braucht ihr einen echten zweiten positiven Kandidaten

Und **hier würde ich jetzt tatsächlich ein anderes OSS-Projekt nehmen**.

Der Unterschied zu meiner vorherigen Empfehlung ist MVP-9a: Wir wissen jetzt empirisch, dass CrankTS kein sinnvoller Anwendungs-Hotspot ist.

Also:

```text
IntentWeave
  positive real-world native case
  PREPARED_STATE

CrankTS
  negative control
  KEEP_TS

external OSS
  search for second positive case
  ideally PURE_BATCH / GRAPH_BATCH / REDUCTION
```

Das ist methodisch viel stärker.

## Ich würde MVP-9 so umschneiden

### MVP-9a — Self-evaluation ✅

Ergebnis:

```text
KEEP_TS control case
```

Fertig. Nicht „gescheitert“.

### MVP-9b — Graph backend crossover

Kleiner, isolierter Experiment-Slice.

Ziel:

```text
Validate GRAPH_BATCH mechanics,
not CrankTS application acceleration.
```

Gate etwa:

- exakte Parity
- realistische Graphrepresentation
- Transferzeit enthalten
- mindestens mehrere Größen
- Crossover ermitteln
- kein notwendiger Whole-App-Speedup

### MVP-9c — externe Candidate Discovery

Jetzt z. B. Knip analysieren/profilieren.

Aber **CrankTS darf dort auch `KEEP_TS` herausbekommen**. Nicht Projekt so lange wechseln, bis Rust gewinnt.

Workflow:

```text
clone
→ representative workload
→ profile
→ crankts analyze
→ assessment
```

Dann erst entscheiden.

### MVP-9d — zweiter Real-Offload

Nur wenn ein echter Kandidat vorliegt.

Ideal wäre eine andere Shape als KWX:

```text
PURE_BATCH
GRAPH_BATCH
REDUCTION
PARALLEL_KERNEL
```

Dann manueller PoC wie bei IW.

---

# Danach v0.2

Und hier würde ich mittlerweile **nicht warten, bis drei positive Projekte existieren**.

Ihr habt mit KWX schon bewiesen:

```text
✓ hotspot detection
✓ semantically narrow island
✓ N-API boundary
✓ exact kernel parity
✓ prepared native state
✓ 17.8× kernel speedup
✓ 2.49× containing region
✓ 18.4% whole workload reduction
```

Das reicht, um den ersten mechanistischen Transformer zu bauen.

Ich würde daher sogar parallelisieren:

```text
                  ┌─ MVP-9b GRAPH_BATCH experiment
MVP-9a done ──────┤
                  ├─ MVP-9c external evaluation
                  │
                  └─ v0.2a PREPARED_STATE transformer
```

**v0.2a sollte den bereits bewiesenen KWX-Fall generalisieren**, nicht auf einen zweiten positiven Kandidaten warten.

---

## Besonders interessant aus MVP-9a: GC

Ein Detail würde ich nicht übersehen:

> **12,4 % Leaf CPU in GC**.

Das heißt nicht automatisch, dass CrankTS selbst Native-Offload braucht. Aber für den Advisor ist das ein sehr gutes Signal.

Ihr habt bisher CPU-Hotness und sampled allocations. Jetzt taucht erstmals ein reales:

```text
GC pressure
```

als erheblicher Workload-Anteil auf.

Mittelfristig sollte das Assessment unterscheiden:

```text
APPLICATION_CPU
RUNTIME_GC
TYPESCRIPT_COMPILER
EXTERNAL_IO
```

Denn bei CrankTS wäre die Diagnose ungefähr:

```text
Application native opportunity: LOW

Dominant costs:
  TYPESCRIPT_COMPILER       VERY HIGH
  GC                        MEDIUM/HIGH

Recommendation:
  KEEP_TS for internal graph kernels
  investigate compiler/program reuse and allocation behavior
```

Das ist wiederum wesentlich hilfreicher als ein Native Priority Score.

---

# Mein konkreter Plan ab jetzt

1. **MVP-9a abschließen und als `KEEP_TS`-Control festhalten.** Keine weitere Self-Optimization erzwingen.

2. **MVP-9b klein durchführen:** WCC/Tarjan `GRAPH_BATCH` TS vs. native auf realer Graphrepräsentation, skaliert. Ziel ist Crossover/Backend-Validierung, nicht 5-%-App-Speedup.

3. **Gleichzeitig v0.2a beginnen:** Aus dem erfolgreichen KWX-PoC eine allgemeine `PREPARED_STATE`-Transformation abstrahieren:
   ```text
   prepare(input) → NativeHandle
   execute(handle, batch) → result
   invalidate/rebuild on mutation
   TS fallback
   differential parity
   ```

4. **Danach externes OSS profilieren**, wahrscheinlich zuerst Knip. Ohne Erwartung, dass Native zwingend sinnvoll sein muss.

5. Findet CrankTS dort einen anderen guten Kandidaten, **manueller zweiter Real-PoC**. Der prüft, ob deine Transformer-Abstraktionen generalisieren.

6. Erst wenn aus KWX + GRAPH_BATCH/external dieselben Konzepte wieder auftauchen, **Native IR stabilisieren**.

Der entscheidende Perspektivwechsel ist daher:

> **MVP-9a ist kein negatives Ergebnis für CrankTS. Es ist ein negatives Ergebnis für einen CrankTS-Self-Offload — und ein positives Ergebnis für die Selektivität des Advisors.**

MVP-9b lohnt sich deshalb noch, aber als **kleiner Backend-Crossover-Test**, nicht mehr als Versuch, aus CrankTS selbst künstlich einen zweiten Erfolgsfall zu machen.