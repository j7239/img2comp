# Puppeteer Iteration Process

Goal: Match reference UI with HTML and CSS using an automated Puppeteer-driven iteration loop.

**Scope:** default state only — no hover / active / focus in this process.

## Prerequisites

Before step 1, confirm all of the following:

- **Node.js 18+** installed (`node --version`).
- **Dependencies installed** via `npm install` — includes `puppeteer`, `pixelmatch`, `pngjs`, `sharp`.
- **Reference file present.** A file named exactly `reference.png` in the project root. **PNG only** — JPG/WebP/SVG are not supported; convert first if needed.
- **Git repository initialized** with a clean working tree (`git status` shows nothing to commit). Iteration history relies on git for commits and rollbacks.
- **Known limitation — transparency.** If `reference.png` has an alpha channel, transparent regions will contribute to the diff against the opaque preview; `iterate.js` flags this in its output. Consider flattening to opaque or cropping first if it inflates the score meaningfully.
- **Known limitation — device pixel ratio.** `iterate.js` pins `deviceScaleFactor: 1` so screenshot pixels equal CSS pixels. If the reference was exported from Figma at @2x, scale it down to its logical-pixel size before using it here.

## Steps

### 1. Init — Automated analysis + user briefing interview

```
node iterate.js init
```

This prints **automated measurements** (canvas size, backdrop color, foreground bounding box, gradient direction hint, 3×3 color grid) and a **visual questionnaire** (Q1–Q10). The same measurements are also written to `.iterate/analysis.json` — read from there for deterministic access instead of parsing stdout.

**Workflow:**
1. Run `node iterate.js init` and read the automated measurements (stdout or `.iterate/analysis.json`).
2. Look at `reference.png`.
3. **Ask the user each question below.** Do not answer them yourself — the user's intent and knowledge of the source design is the input, not a pixel-reading guess. Ask all questions in one message so the user can answer in one pass. Tailor each question based on what's visible in the reference (e.g. if the element is clearly circular, skip the corner-radius options and just confirm).
4. **Wait for the user's answers** before writing any CSS or markup. Do not proceed to step 2 until confirmed.

The answers replace guesswork in the first CSS pass. A complete briefing typically brings the opening diff score from ~8–12% down to ~2–4%.

---

**Questions to ask the user (Q1–Q10):**

**Q1. Background fill** — What type of fill does the element have? (solid color / linear gradient — direction + stops / radial gradient — center position / complex mesh / transparent)

**Q2. Glass / blur** — Is there a `backdrop-filter: blur` frosted-glass effect, or is the element opaque?

**Q3. Border** — Describe the border(s): none / solid color / gradient border (angle + stops) / inner highlight line on one edge / multiple stacked.

**Q4. Outer shadows** — How many distinct outer shadows? For each: which direction (top-left lift, bottom-right drop, ambient), approximate color, spread, and blur.

**Q5. Inner shadows / glow** — Any inset depth effects? For each: which edge, light or dark, approximate size.

**Q6. Highlight / sheen** — Is there a specular highlight? Top-edge bright line / interior gradient highlight / iridescent or multi-color arc / none.

**Q7. Corner radius** — Sharp / slight (4–8px) / medium (12–20px) / large (24–40px) / pill / fully circular.

**Q8. Icon or label** — None / icon only (what does it depict, line or filled style, approximate size relative to element) / text only (weight, case, size) / icon + text. If an icon or custom font is needed, confirm which kit or typeface to use before writing markup.

**Q9. Overall depth style** — Flat / subtle elevation (single drop shadow) / neumorphic (dual shadow + inset) / glass-frosted / layered-rich (multiple stacked effects).

**Q10. Anything else** — Effects not covered: noise texture, outline glow, gradient border animation, irregular shape, anything the user wants to flag about the design intent or source tool values.

---

### 2. First pass — Write real CSS from the brief, score it immediately

Do **not** scaffold a blank stub first. Use the briefing answers and `reference.png` together to write a genuine first attempt at the full element — structure, fill, border, shadows, and inner content all in one pass. The first `node iterate.js` run scores this real attempt, not a placeholder.

**How to write the first pass:**
- Translate each Q1–Q10 answer directly to CSS. Q1 → `background`, Q2 → `backdrop-filter`, Q3 → `border` / `outline`, Q4–Q5 → `box-shadow`, Q6 → an additional gradient layer or pseudo-element, Q7 → `border-radius`, Q8 → markup + icon/font.
- Use the 3×3 color grid from `init` as your starting palette for the fill and shadow colors.
- Use reference-pixel values directly (e.g. `top: 128px; width: 285px`). `.button-preview` is sized to `reference.png`'s natural dimensions in both the browser view and the screenshot pipeline, so 1px in CSS equals 1px in the diff.
- This pass will not be perfect — the goal is a structurally correct first attempt that diff.png can meaningfully guide, not a polished result.

Once written:
- Run `node iterate.js` to capture the first real score and `diff.png`.
- Commit: `git add index.html && git commit -m "first pass: <score>%"`.
- This is the anchor for all future iteration — every improvement is measured from here.

### 3. Technology contract — CSS-first
Before any styling, commit to the tech stack. The reference was built in a vector tool (Figma / Illustrator) with standard effects, so every primitive has a direct CSS equivalent. **Always prioritize CSS** — it produces the most usable, accessible, performant web output.

1. **Pure CSS (default choice).** Map vector effects directly:
   - Fill → `background: linear-gradient() / radial-gradient() / conic-gradient()` — use `in oklch` or `in oklab` to match Figma's linear-RGB interpolation (sRGB defaults shift gradient midpoints).
   - Stroke → `border` (or `outline` for outside strokes).
   - Drop shadow → `box-shadow` (use `filter: drop-shadow()` for non-rectangular shapes).
   - Inner shadow → `box-shadow: inset`.
   - Layer blur → `filter: blur()`.
   - Background blur → `backdrop-filter: blur()` (the mechanism behind glass effects).
   - Blend modes → `mix-blend-mode`, `background-blend-mode`.
   - Corner radius → `border-radius`.
   - Design tokens → CSS custom properties (`--base`, `--highlight`, etc.) fed by the values sampled in step 4.

2. **Inline SVG** — only when CSS can't express the shape cleanly: complex paths, non-rectangular gradients, icons traced from the reference. Still vector, never raster.
   - **Must scale 1:1 with `.button-preview`.** Always set `viewBox="0 0 <refW> <refH>"` using the reference's pixel dimensions, and size the SVG element with `width: 100%; height: 100%` (or the pixel dims directly — the container is already sized to the reference). Omit raw `width="…"` / `height="…"` attributes, which lock the SVG to intrinsic size and break both the browser view and the auto-resized screenshot. Leave `preserveAspectRatio` at the default (`xMidYMid meet`) unless you have a specific reason to change it.

3. **SVG filters** — last resort, for `<feTurbulence>` / `<feGaussianBlur>` / `<feDisplacementMap>` effects (grain, noise, refraction) that CSS can't reach. Use sparingly.

4. **Explicit bans:**
   - No raster images (PNG/JPG) for the target element.
   - No Canvas / WebGL — wrong tool for static UI, breaks accessibility, selectability, and responsive scaling.
   - No CSS frameworks (Tailwind, styled-components, "glassmorphism" packages) — hand-rolled CSS keeps output auditable and iteration honest.

**Rule of thumb:** if an edit reaches for SVG or an external library, first check whether a CSS property already covers it. It almost always does.

### 4. Measure dimensions, then sample colors
Order matters — bounds must be known before color samples can land on the element.

- **Start with `node iterate.js inspect`.** It prints the reference canvas dims, the backdrop color (mode of border-ring samples), the foreground bounding box, and the icon bounding box. For simple scenes (backdrop + target only) it also suggests a `MASK_BOX` rect; for complex references (panels, textures, scenery competing with the target) it prints a coverage warning and you fall back to measuring by eye.
- **Dimensions (by eye if inspect warned).** Open `reference.png` in an image viewer / browser devtools and record:
  - element width × height in px,
  - position within the reference canvas,
  - icon / inner-content size,
  - approximate shadow extent outside the element.
- **Colors.** Refine the `SAMPLE_POINTS` fractions in `iterate.js` so each sample lands on the element (not the backdrop), then run `node iterate.js sample`. This:
  - prints each sampled point to stdout, and
  - writes `.iterate/palette.json` with all values (persisted so the palette survives closed terminals).
- Feed the sampled hex values into CSS custom properties per step 3.

### 5. Canvas alignment (automatic)
- `iterate.js` reads `reference.png`'s pixel dimensions and **automatically resizes `.button-preview`** to match before every screenshot. The element-level screenshot (`.iterate/screenshots/implementation.png`) is therefore always exactly the same dims as the reference — `pixelmatch` compares raw against raw with no stretching.
- **Browser view is 1px:1px with the diff.** `index.html` contains an inline script that reads `reference.png`'s natural dimensions on page load and sets `--ref-w` / `--ref-h` CSS variables; both `.reference-image` and `.button-preview` are sized off those variables. Opening `index.html` in a browser renders the element at exactly the same dimensions it will be screenshotted at, and the comparison container is flex-centered in the viewport. You can write reference-pixel values directly (`top: 128px; width: 285px`) and the browser view will match the diff — no need for `%` / `aspect-ratio` workarounds.
- If the auto-sizing ever fails (element missing, puppeteer error), `iterate.js` falls back to `sharp`'s `fit: 'cover'` resize and logs a warning. If you see the warning, fix the root cause — don't ignore it.
- **Scope scoring to the foreground with `MASK_BOX`.** When the reference has non-target scenery that step 1 put out of scope (textures, panels, secondary elements), set `MASK_BOX` at the top of `iterate.js` to a `{ x, y, width, height }` rect in reference-pixel coords. With it set, `pixelmatch` only counts mismatched pixels inside the rect, and the reported percentage is out of the rect's area — so the score reflects actual foreground progress instead of being swamped by scenery noise. `node iterate.js inspect` suggests a rect when auto-detection succeeds; otherwise measure by hand. Leave `MASK_BOX = null` to score the full canvas.
- **Known caveat:** backdrop mismatch. If the reference has a textured/patterned backdrop and `.button-preview` has a different (e.g., cream gradient) backdrop, every backdrop pixel shows up as a diff. The score will be inflated but the *trend* (going down = improving) remains useful, and `diff.png` still visually highlights foreground gaps. The cleanest fix is `MASK_BOX` above; alternatives are matching the backdrop, sampling an average solid color from the reference corners, or cropping to a foreground ROI.

### 6. Build & iterate using `iterate.js` (the core loop)

**Recommended:** launch watch mode once at the start of the session and let the tool drive the loop:

```
node iterate.js watch --commit-on-improve --revert-on-regress
```

This keeps puppeteer and the HTTP server alive, re-renders and re-diffs on every `index.html` save (~100ms debounce), auto-commits when the score drops by ≥ 0.25pp, and auto-reverts when the score goes up. You focus on CSS edits; the scoring, committing, and reverting run themselves. Leave it running in a terminal next to your editor. `--with-sidebyside` additionally emits `.iterate/screenshots/default.png` on each run.

Each iteration is one pass through this loop:

1. **Save `index.html`** — watch mode re-renders and re-diffs automatically. Without watch, run `node iterate.js` by hand.
2. **Read the prescription, don't re-derive it.** `.iterate/screenshots/diff-report.json` carries a `suggestedEdit` block computed deterministically from the metrics:
   ```
   suggestedEdit: {
     axis: "color" | "tone" | "geometry" | "position",
     region: "top-left" | ... | "bottom-right",
     regionSeverity: <% mismatch in worst 3×3 cell>,
     confidence: 0–1,
     cssTargets: ["background", "box-shadow", ...],
     stalled: <true if the same axis was suggested last run with no real drop>,
     hint: "one-sentence next action"
   }
   ```
   The axis mapping (`deltaE` → color, `lumDelta` → tone, `edgePct` → geometry, else position) used to live in this section as prose — it's now encoded in `iterate.js` so the per-iteration decision is a lookup rather than a reasoning pass. Fall back to `diff.png` + the raw `grid` only when `confidence < 0.3` (residual noise — the suggestion is weak) or `stalled === true` (the mechanical lever has run out of room).
3. **Make one named, targeted edit** on a property in `cssTargets`, following `hint`. Name what you're fixing in one sentence (see CSS guardrails, step 7). If `stalled === true`, make a **structural** change — flip gradient direction, swap base color, reorder shadow layers, switch `in srgb` → `in oklch` — not another small tweak on the same axis. The `diff.png` signed overlay (red = impl too bright, green = impl too dark) is still the tiebreaker for direction when the hint is ambiguous.
4. **Save** — the next diff fires automatically.
5. **Regression guard.** With `--commit-on-improve --revert-on-regress` the tool handles this: drops ≥ 0.25pp get committed with message `iter auto: <score>%`, regressions get reverted (`git checkout -- index.html`), no-ops (<0.25pp change) do neither — the file stays dirty so you can rethink structurally. Without the flags, do the same by hand: `git add index.html && git commit -m "iter N: <score>% — <named target>"` on drops, `git checkout -- index.html` on regressions.
6. **Review the trend.** Two logs, two purposes:
   - `.iterate/scores.log` — human-readable timeline (`ΔE`, `lumΔ`, `edges`, `edits=<css-props>`). Skim to see whether the trend is improving.
   - `.iterate/history.jsonl` — one JSON line per iteration with `score`, `prev`, `delta`, `axis`, `region`, `stalled`, `drivenBy` (which axis actually drove this edit — the *previous* suggestion), and `outcome` (`improved` / `regressed` / `noop` / `committed` / `reverted`). Read the last ~5 lines of this instead of re-parsing git log + scores when you need to know which axes have already been tried. If 3 consecutive entries show `outcome: "regressed"` or `outcome: "noop"` on the same `drivenBy`, stop and rethink structurally.
7. **Multi-step rollback** (when iteration has drifted): inspect `git log --oneline` to find the best prior state, then `git checkout <sha> -- index.html` to restore it. Commit the reset as its own entry (`git commit -m "reset to iter K: <score>%"`) so the log stays linear.

The side-by-side `.iterate/screenshots/default.png` is for human review only — never the diff input.

**Delegating to the `iter-edit` subagent (optional, for speed).** Once watch mode is running and the first pass has anchored the baseline, the main session can offload the per-iteration edit to the `iter-edit` subagent defined in `.claude/agents/iter-edit.md`. That agent runs on a smaller model, reads only the `suggestedEdit` and current `index.html`, and returns a one-line named target + the edit applied — no metric interpretation, no prose. Use it when: (a) the loop is tight and steady on a single axis, (b) `confidence ≥ 0.5`, and (c) `stalled === false`. Stay in the main session for: the first pass (step 2), stalled loops, structural rethinks, and the every-3-iteration check-in with the user (step 8). The subagent is a throughput optimization for the mechanical middle of the loop — not a replacement for the judgment calls at its boundaries.

### 7. CSS guardrails
Apply on every edit in step 6:

- **Named target per edit.** Every change must have a one-sentence purpose ("darken the bottom shadow," "widen the top highlight"). If you can't name what you're fixing, you're fitting to noise — stop and look at `diff.png` again.
- **Diminishing-returns cutoff.** If an iteration drops the score by less than ~0.25 percentage points and no visible gap is closing, stop layering. Rethink the structure instead of adding more.
- **Layer caps per property.** Soft limits: max ~3 gradient stops per `background` layer, max ~4 shadows in a `box-shadow`. Beyond that is almost always chasing pixel noise, not visible improvement.
- **Prune no-ops.** After an iteration that improved the score, try deleting the rule just added. If the score and the visual don't change when it's gone, the rule was noise — delete it.
- **Prefer one structural move over three tweaks.** If three iterations in a row produce tiny gains, the next edit should be a bigger restructuring (change the base gradient, flip the shadow direction), not another small adjustment.
- **CSS-first enforcement.** If an edit reaches for SVG or an external library, first confirm no CSS property covers it. SVG is a fallback, not a convenience.

### 8. Check in with user every 3 iterations (5 if the trend is clean)
- After every 3 iterations of step 6, pause — **unless the last 3 each dropped the score by ≥ 0.25pp with no regressions in between**, in which case extend the window to 5 before pausing. Monotonic improvement has earned the trust; don't interrupt it.
- Show the user the latest `.iterate/screenshots/default.png` side-by-side with `reference.png`, plus the `.iterate/scores.log` trend (e.g., `baseline 8.81% → 5.40% → 3.12% → 2.08%`).
- Ask: keep iterating, change direction, or call it done?
- Do not silently continue past the check-in window — diminishing returns and subjective "close enough" calls belong to the user, not me.

### Done criteria (calibration)
The user makes the final call, but these are the thresholds I use to suggest stopping:

- **Strong candidate for "done":** `pixelmatchPct` under ~0.5%, `ΔE` under ~2 (sub-JND color error), `edgePct` under ~1%, `diff.png` shows no visible foreground gaps, and the last 3 iterations each moved the score by <0.25pp. Propose calling it done.
- **Keep going:** any metric still dropping meaningfully, or `diff.png` shows an obvious unaddressed foreground gap, or the grid has a cell above ~5% while the overall score is low.
- **Stop and rethink:** score plateaued above ~1% for 3+ iterations, or regressing, or one metric axis refuses to move (e.g. `edgePct` stuck while `ΔE` drops — geometry is structurally wrong, not a color problem). Consider reverting to an earlier commit and trying a different base structure.
- **Caveat:** if the backdrop caveat in step 5 is inflating `pixelmatchPct`, these thresholds refer to the *foreground-visible* state, not the raw number. Use the grid breakdown and `diff.png` as the tiebreaker.
