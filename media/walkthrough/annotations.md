## Sidenotes, marginal notes & sidebars

The headline feature — annotations that float alongside your text, with full Markdown **inside** the note.

**Sidenote** — put `reference|note` between `++`:

```
Kingfishers dive fast++they hit the water at ~40 km/h|Aiming for small fish spotted from a perch.++.
```

**Marginal note** — the same, between `!!`:

```
The bridge opened in 1937!!see plaque|Painted "International Orange" to stay visible in fog.!!.
```

**Sidebars** — a left marker with `$…$`, a right marker with `@…@`:

```
$09:00$ Opening remarks @Chair@
```

Add attributes to any of them, e.g. `++ref|note++{.highlight}`.

> Type `sidenote` or `marginnote` and press <kbd>Tab</kbd> to expand a snippet.
