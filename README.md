# UI Iteration Template

Turn a design into code, one careful step at a time.

Drop in a picture of the UI you want to match. This template renders your version, compares it to the original, shows you exactly where they differ, and keeps score as you get closer. No more guessing whether you're on track — every change gets measured.

Works on its own, but pairs with **Claude Code** for guided iteration.

## What it does

- Renders `index.html` with headless Chromium and screenshots the target element at the reference's exact pixel dimensions.
- Runs `pixelmatch` against `reference.png` to produce:
  - a numeric diff score (percentage of mismatched pixels), and
  - a visual diff map (`screenshots/diff.png`) highlighting where the gaps are.
- **Watch mode** keeps puppeteer + the HTTP server alive, re-diffs on every `index.html` save, and optionally auto-commits improvements / auto-reverts regressions so the iteration loop runs itself.
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

Claude will read [PROCESS.md](PROCESS.md) and follow the 8-step workflow: analyze reference, scaffold a baseline, commit to a CSS-first tech stack, sample colors and dimensions, iterate with named edits, commit on improvement / revert on regression, and check in with you every 3 iterations.

For stronger enforcement (no need to re-say it every session), add a short `CLAUDE.md` pointing at `PROCESS.md` — Claude Code auto-loads `CLAUDE.md` into every session.

## How the iteration works (short version)

1. **Analyze** — separate foreground element from backdrop; identify any icon/text and pick a free kit (Lucide, Inter, etc.).
2. **Scaffold** — empty `.button-preview` shell, run `iterate.js` once, capture the baseline.
3. **Tech contract** — CSS first (direct Figma-effect-to-CSS-property mapping); SVG only when CSS can't; no raster / Canvas / frameworks.
4. **Measure + sample** — run `node iterate.js inspect` for auto-measured bboxes and a suggested `MASK_BOX`; then `node iterate.js sample` for colors.
5. **Loop** — start `node iterate.js watch --commit-on-improve --revert-on-regress` once. Every save re-diffs, auto-commits on a ≥ 0.5pp drop, auto-reverts on a regression. Read `diff.png` between edits to pick the next named target.
6. **Guardrails** — named target per edit; diminishing-returns cutoff at 0.5pp; layer caps (~3 gradient stops, ~4 shadows); prune no-ops.
7. **Check in every 3 iterations** (5 if the trend is monotonic) — propose "done" when the score is under ~1% with no visible foreground gaps.

Full detail in [PROCESS.md](PROCESS.md).

## File structure

```
.
├── .gitignore
├── PROCESS.md          authoritative workflow
├── README.md           this file
├── index.html          scaffold with .button-preview target
├── iterate.js          render + diff + color-sample CLI
├── package.json
├── reference.png       the target design (replace with your own)
└── screenshots/        outputs written here (gitignored)
```

## Scope

- **Default state only.** No hover / active / focus states.
- **Single foreground element.** The process targets one element per reference — swap the reference to iterate on the next.
- **Vector-origin references.** The tech contract assumes the reference was built in Figma / Illustrator with standard effects. It may still work for photographic references, but CSS-first mapping loses leverage.

## Known caveats

- **Backdrop mismatch inflates the score.** If the reference has a textured backdrop that `.button-preview` doesn't match, the raw percentage rises. The cleanest fix is to set `MASK_BOX` at the top of `iterate.js` to a rect around the target — `pixelmatch` then only counts mismatched pixels inside, and the reported % reflects foreground progress. Alternatives: match the backdrop in CSS, sample a solid fallback color, or crop the reference to the foreground region.
- **Reference with alpha channel.** Transparent pixels read as their raw channel values during sampling and contribute to the diff against the opaque preview. `iterate.js` flags this in its output.
- **DPR is pinned to 1.** Screenshots are taken at 1:1 with CSS pixels. High-DPR references must be scaled before use.
