# README diagrams

The three diagrams in the main README are images, so they show the same everywhere, including the Obsidian Community directory page, which doesn't draw Mermaid. These `.mmd` files are their source.

| Source | Images |
|---|---|
| `journey.mmd` | `journey-light.png`, `journey-dark.png` |
| `feature-map.mmd` | `feature-map-light.png`, `feature-map-dark.png` |
| `ai-agents.mmd` | `ai-agents-dark.png` (dark only, by design) |

## Regenerating the images

After editing a `.mmd` file, run this from the repo root (needs Node.js; `npx` downloads [mermaid-cli](https://github.com/mermaid-js/mermaid-cli) the first time):

```sh
for d in journey feature-map; do
  npx -y @mermaid-js/mermaid-cli@12.0.0 -i docs/diagrams/$d.mmd -o docs/diagrams/$d-light.png -t default -b '#ffffff' -s 2
  npx -y @mermaid-js/mermaid-cli@12.0.0 -i docs/diagrams/$d.mmd -o docs/diagrams/$d-dark.png -t dark -b '#0d1117' -s 2
done
npx -y @mermaid-js/mermaid-cli@12.0.0 -i docs/diagrams/ai-agents.mmd -o docs/diagrams/ai-agents-dark.png -t dark -b '#0d1117' -s 2
```

`-s 2` renders at twice the size so text stays sharp. The dark background matches GitHub's dark theme.

## How the README shows them

`ai-agents-dark.png` is a plain `<img>`: one dark image for every reader, so its colours stay the same. The other two are each a `<picture>`: the light PNG by default, the dark PNG when the reader's system is in dark mode. The dark version is linked by its full `raw.githubusercontent.com/…/HEAD/…` address, so it also loads on pages that copy the README elsewhere. It only resolves once the file is on the default branch.

## Notes on the source

- `⚙️ <name> · on/off` is a switch in Sheiko's settings and its default. Names match the settings tab (`src/settings.ts`). Defaults match `DEFAULT_SETTINGS`.
- In `ai-agents.mmd`, colours mean who acts: orange `#f0883e` for AI agents, blue `#58a6ff` for Sheiko, green `#3fb950` for the user. They're set with `classDef` (boxes and text), `style` (lanes) and `linkStyle` (arrows, by edge order). **If you add or reorder an edge, update the `linkStyle` indexes.**
- `wrappingWidth: 360` in each file's front matter keeps boxes wide enough that the setting names fit on one line.
- Check the journey against the code when the flow changes: `checkCutoff` in `src/main.ts` (end-of-day roll and prompt are separate), and the buttons in `src/ui/signoff-modal.ts` and `src/ui/signedoff-modal.ts`.
