# Art sources

`beads-ui-icon.svg` is the master logo: two bead strands converging on a goal bead —
the dependency graph the extension draws, made of beads. `resources/beads-icon.svg`
is the monochrome activity-bar version of the same mark (uses `currentColor`).

Regenerate the marketplace icon (`resources/icon.png`) from the master SVG:

```bash
bun add -d sharp
bun -e "require('sharp')('art/beads-ui-icon.svg',{density:300}).resize(256,256).png().toFile('resources/icon.png')"
bun remove sharp
```

Files with a `beads-logo-*` prefix are legacy assets from the upstream fork
(Flaticon-derived) and are no longer used.
