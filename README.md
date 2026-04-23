# UI Iteration Template

Turn a design into code, one careful step at a time.

Drop in a picture of the UI you want to match. This template renders your version, compares it to the original, shows you exactly where they differ, and keeps score as you get closer. No more guessing whether you're on track — every change gets measured.

Works on its own, but pairs with **Claude Code** for guided iteration.

## What it does

- Renders `index.html` with headless Chromium and screenshots the target element at the reference's exact pixel dimensions. Font hinting and subpixel AA are pinned off, and the screenshot waits for `document.fonts.ready` + two animation frames — so glyph / compositor noise doesn't flicker the score between runs.
- Compares against `reference.png` and emits a **multi-axis diff** on every cycle, not a single scalar:
  - `pixelmatchPct` — overall mismatched-pixel percentage.
  - `ΔE` (CIE Lab) — mean perceptual color error (is the *fill color* wrong?).
  - `lumΔ` — signed luminance bias (is the impl too bright or too dark overall?).
  - `edgePct` — Sobel-map mismatch (is the *geometry* — border radius, shadow shape, icon silhouette — wrong?).
  - **3×3 grid breakdown** — mismatch % per cell, so you immediately know *where* the error lives.
  - **Signed overlay** at `screenshots/diff.png` — **red** where impl is too bright, **green** where impl is too dark, over a dimmed reference base. Direction, not just magnitude.
  - **`screenshots/diff-report.json`** — every metric above, structured for programmatic reads.
- **Watch mode** keeps puppeteer + the HTTP server alive, re-diffs on every `index.html` save (CSS-only changes use hot injection; all `<style>` blocks are patched correctly), and optionally auto-commits improvements / auto-reverts regressions so the iteration loop runs itself.
- **`init` mode** auto-measures the reference (canvas, backdrop, foreground bbox, gradient hint, 3×3 color grid, alpha presence) and writes `analysis.json` so consumers (CI, AI assistants) can read deterministic JSON instead of parsing stdout.
- **`inspect` mode** auto-measures the backdrop, foreground bbox, and icon bbox — and suggests a `maskBox` rect so the score ignores scenery you don't own. With `maskBox` set, the diff pre-crops both images with `sharp.extract` before scoring — scales cleanly to large references.
- Samples exact hex/RGB colors from the reference at named coordinates — no eyeballing.
- Persists the score trend to `scores.log` (de-duplicated), now annotated per line with `ΔE`, `lumΔ`, `edges`, and the CSS properties changed since last commit (`edits=background,box-shadow,...`) so the trend tells you *what kind of edit* is converging.

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

All generated output is written under `.iterate/` (gitignored). Nothing generated touches the project root.

```
.iterate/
├── analysis.json                reference measurements from `init` (backdrop, bbox, grid colors)
├── palette.json                 sampled colors (sample mode only)
├── scores.log                   append-only score trend (with ΔE, lumΔ, edges, edits tags)
└── screenshots/
    ├── default.png              side-by-side layout, human review (--with-sidebyside only)
    ├── implementation.png       element-level crop of .button-preview (diff input)
    ├── diff.png                 signed overlay: red = impl too bright, green = impl too dark
    └── diff-report.json         structured metrics (pixelmatch, ΔE, lumΔ, edges, 3×3 grid)
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
5. **Loop** — start `node iterate.js watch --commit-on-improve --revert-on-regress` once. Every save re-diffs; CSS-only saves use hot injection (~100ms). Auto-commits on a ≥ `improveThresholdPp` drop (default 0.25pp), auto-reverts on a regression. Between edits, use the **3×3 grid** to pick *where* to target and the **metric breakdown** to pick *what kind* of edit: high `ΔE` → fix fill colors; non-zero `lumΔ` → global tone is off; high `edgePct` → geometry (radius, stroke, shadow shape) is off. The signed `diff.png` tells you the *direction* (red = pull brightness down, green = push brightness up).
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

The root holds only the **base template** — code, config, docs, and the user's `reference.png`. Everything generated lives under `.iterate/`, which is gitignored as a whole.

```
.
├── .gitignore
├── iterate.config.json  tunable constants (selector, maskBox, samplePoints, threshold)
├── PROCESS.md           authoritative workflow
├── README.md            this file
├── index.html           scaffold with target element
├── iterate.js           render + diff + color-sample CLI
├── package.json
├── reference.png        the target design (you provide this)
└── .iterate/            all generated output (gitignored)
    ├── analysis.json    reference measurements from `init`
    ├── palette.json     sampled colors (sample mode only)
    ├── scores.log       score trend with per-run metrics
    └── screenshots/
        ├── implementation.png  element crop (diff input)
        ├── diff.png            signed overlay (red = too bright, green = too dark)
        ├── diff-report.json    structured metrics for programmatic consumption
        └── default.png         side-by-side (--with-sidebyside only)
```

## Scope

- **Default state only.** No hover / active / focus states.
- **Single foreground element.** The process targets one element per reference — swap the reference to iterate on the next.
- **Vector-origin references.** The tech contract assumes the reference was built in Figma / Illustrator with standard effects. It may still work for photographic references, but CSS-first mapping loses leverage.

## Known caveats

- **Backdrop mismatch inflates the score.** If the reference has a textured backdrop that the target element doesn't match, the raw percentage rises. The cleanest fix is to set `maskBox` in `iterate.config.json` to a rect around the target — `pixelmatch` then only counts mismatched pixels inside, and the reported % reflects foreground progress. Run `node iterate.js inspect` to get a suggested rect. Alternatives: match the backdrop in CSS, sample a solid fallback color, or crop the reference to the foreground region.
- **Reference with alpha channel.** Transparent pixels read as their raw channel values during sampling and contribute to the diff against the opaque preview. `iterate.js` flags this in its output.
- **DPR is pinned to 1.** Screenshots are taken at 1:1 with CSS pixels. High-DPR references must be scaled before use.
