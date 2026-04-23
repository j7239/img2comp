# UI Iteration Template

Turn a design into code, one careful step at a time.

Drop in a picture of the UI you want to match. This template renders your version, compares it to the original, shows you exactly where they differ, and keeps score as you get closer. No more guessing whether you're on track — every change gets measured.

Works on its own, but pairs with **Claude Code** for guided iteration.

## What it does

- Renders `index.html` with headless Chromium and screenshots the target element at the reference's exact pixel dimensions.
- Runs `pixelmatch` against `reference.png` to produce:
  - a numeric diff score (percentage of mismatched pixels), and
  - a visual diff map (`screenshots/diff.png`) highlighting where the gaps are.
- **Watch mode** keeps puppeteer + the HTTP server alive, re-diffs on every `index.html` save (CSS-only changes use hot injection, skipping a full reload), and optionally auto-commits improvements / auto-reverts regressions so the iteration loop runs itself.
- **`inspect` mode** auto-measures the backdrop color, foreground bounding box, and icon bounding box — and suggests a `MASK_BOX` rect so the score ignores scenery you don't own.
- Samples exact hex/RGB colors from the reference at named coordinates — no eyeballing.
- Persists the score trend to `scores.log` (with de-duplication of identical consecutive results) and the sampled palette to `palette.json` so progress and design tokens survive closed terminals.

## Prerequisites

- **Node.js 18+**
- **Git** (iteration relies on commits per improvement and `git checkout` for rollback)
- **`reference.png`** in the project root — **PNG only**. Convert JPG/WebP/SVG beforehand. If exported from Figma at @2x, scale to logical-pixel size first (the diff pins `deviceScaleFactor: 1`).

## Quick start

```bash
npm install
# Replace reference.png with your target design
node iterate.js init                # analyze reference + print briefing questionnaire (start here)
node iterate.js                     # one-shot render + diff against reference.png
node iterate.js sample              # extract color palette from reference.png
node iterate.js inspect             # measure backdrop + foreground + icon bboxes
node iterate.js watch \
    --commit-on-improve \
    --revert-on-regress             # recommended: auto-rerun on save + auto-commit/revert
```

First run writes:

```
screenshots/default.png         side-by-side layout, for human review
screenshots/implementation.png  element-level crop of .button-preview (diff input)
screenshots/diff.png            mismatched regions visualised
scores.log                      append-only score trend
palette.json                    sampled colors (sample mode only)
```

## Using with Claude Code

Start a session and say:

> use PROCESS.md

Claude will read [PROCESS.md](PROCESS.md) and follow the 8-step workflow: run `init` to analyze the reference and brief you with Q1–Q10, write a first CSS pass from your answers, commit to a CSS-first tech stack, sample colors and dimensions, iterate with named edits, commit on improvement / revert on regression, and check in with you every 3 iterations.

For stronger enforcement (no need to re-say it every session), add a short `CLAUDE.md` pointing at `PROCESS.md` — Claude Code auto-loads `CLAUDE.md` into every session.

## How the iteration works (short version)

1. **Init** — run `node iterate.js init`. Prints automated measurements (canvas size, backdrop, foreground bbox, gradient direction, 3×3 color grid) and a 10-question visual briefing. Answer Q1–Q10 before writing any CSS.
2. **First pass** — write real CSS directly from the briefing answers; no blank stub. Run `iterate.js` to score it.
3. **Tech contract** — CSS first (direct Figma-effect-to-CSS-property mapping); SVG only when CSS can't; no raster / Canvas / frameworks.
4. **Measure + sample** — run `node iterate.js inspect` for auto-measured bboxes and a suggested `maskBox`; set it in `iterate.config.json`, then `node iterate.js sample` for colors (define named points under `samplePoints` in the config).
5. **Loop** — start `node iterate.js watch --commit-on-improve --revert-on-regress` once. Every save re-diffs; CSS-only saves use hot injection (~100ms). Auto-commits on a ≥ `improveThresholdPp` drop (default 0.25pp), auto-reverts on a regression. Read `diff.png` between edits to pick the next named target.
6. **Guardrails** — named target per edit; diminishing-returns cutoff at 0.5pp; layer caps (~3 gradient stops, ~4 shadows); prune no-ops.
7. **Check in every 3 iterations** (5 if the trend is monotonic) — propose "done" when the score is under ~1% with no visible foreground gaps.

Full detail in [PROCESS.md](PROCESS.md).

## Configuration — `iterate.config.json`

All tunable constants live in `iterate.config.json` (no need to edit `iterate.js`):

| Key | Default | Description |
|-----|---------|-------------|
| `selector` | `".button-preview"` | CSS selector of the element to screenshot and diff |
| `improveThresholdPp` | `0.25` | Minimum score drop (percentage points) to trigger auto-commit |
| `maskBox` | `null` | `{ x, y, width, height }` rect (reference-pixel coords) to limit scoring to a foreground region; `null` scores the full canvas |
| `samplePoints` | `{}` | Named color sample points as fractional coords, e.g. `{ "top": [0.5, 0.1] }` |

## File structure

```
.
├── .gitignore
├── iterate.config.json  tunable constants (selector, maskBox, samplePoints, threshold)
├── PROCESS.md           authoritative workflow
├── README.md            this file
├── index.html           scaffold with target element
├── iterate.js           render + diff + color-sample CLI
├── package.json
├── reference.png        the target design (replace with your own)
└── screenshots/         outputs written here (gitignored)
```

## Scope

- **Default state only.** No hover / active / focus states.
- **Single foreground element.** The process targets one element per reference — swap the reference to iterate on the next.
- **Vector-origin references.** The tech contract assumes the reference was built in Figma / Illustrator with standard effects. It may still work for photographic references, but CSS-first mapping loses leverage.

## Known caveats

- **Backdrop mismatch inflates the score.** If the reference has a textured backdrop that the target element doesn't match, the raw percentage rises. The cleanest fix is to set `maskBox` in `iterate.config.json` to a rect around the target — `pixelmatch` then only counts mismatched pixels inside, and the reported % reflects foreground progress. Run `node iterate.js inspect` to get a suggested rect. Alternatives: match the backdrop in CSS, sample a solid fallback color, or crop the reference to the foreground region.
- **Reference with alpha channel.** Transparent pixels read as their raw channel values during sampling and contribute to the diff against the opaque preview. `iterate.js` flags this in its output.
- **DPR is pinned to 1.** Screenshots are taken at 1:1 with CSS pixels. High-DPR references must be scaled before use.
