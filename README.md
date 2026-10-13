# VectorTrace

Browser-based bitmap-to-vector tracer. Upload a PNG, JPG or WebP image, trace it into editable
paths made of lines and cubic Béziers, compare against the source, and export a standalone SVG
for CorelDRAW (or any vector editor). Images never leave the browser.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run typecheck
npm run build
```

## Workflow

1. **Upload Image** (button, drag-and-drop on the sidebar or canvas).
2. Pick a **tracing mode** and adjust settings.
3. **Trace Image** (Ctrl/⌘+Enter). With *Live preview* on, later setting changes retrace automatically after a short delay.
4. Inspect with **Original / Traced / Split / Bitmap** views, zoom (wheel, +/−), pan (drag, arrow keys), **Fit** (0) and **1:1** (1). Toggle source, vector paths and nodes.
5. **Export SVG** (Ctrl/⌘+S).

### Importing into CorelDRAW

File → Import (Ctrl+I) → select the SVG → place it. Paths arrive as editable curves; holes are
combined into their parent shape (even-odd fill). Ungroup (Ctrl+U) to edit objects individually,
then File → Save As → **CDR**.

VectorTrace writes SVG, not native `.cdr` files. Direct CDR output would need CorelDRAW itself or a
dedicated converter.

## Tracing modes

| Mode | What it does |
| --- | --- |
| Centerline (default) | Finds the middle of every stroke and emits one open path (or closed loop) per stroke, with its measured width. See below. |
| Outline | Global/Otsu threshold → closed outer and hole contours. Exported as outlines by default. |
| Line art | Adaptive (local-mean) threshold so shading is not filled; strokes become thin filled shapes with two boundaries. |
| Silhouette | Threshold + morphological closing + speck removal → solid filled shapes with holes (optional *Fill all holes*). |

### Centerline pipeline

1. Threshold and clean the bitmap (small gaps closed according to *Smoothing*).
2. Exact Euclidean distance transform (Felzenszwalb–Huttenlocher) — gives the local stroke radius.
3. Zhang–Suen thinning plus staircase removal → a strictly 1-px, 8-connected skeleton.
4. Skeleton graph: endpoints and junction clusters become nodes, pixel runs become edges.
5. Cleanup: branches shorter than ~1.5× the local radius + *Branch pruning* are removed; nearby
   junctions (e.g. the two halves of an X crossing) are merged; optional *Gap closing* joins aligned
   free ends across small breaks.
6. At each junction, edge ends are paired by straightness (*Join angle*) so a "+" becomes two
   continuous strokes and a "T" becomes one through-stroke plus a branch.
7. Line ends are extended along their tangent to the true stroke tip (*Tip*), to tip − radius so a
   round-capped stroke reproduces the original length (*Round cap*, default), or left as-is (*None*).
8. Each stroke is smoothed and fitted with cubic Béziers; junction points stay pinned so strokes meet
   exactly.

Export options: one uniform stroke width (the detected median, or a custom value) or *Per stroke*,
which writes each path with its own measured width. Use the *Hairline* view to inspect the paths.

### Geometry: straight edges, circles and arcs

Mechanical drawings (gears, nuts, brackets) are made of straight edges and circular arcs. A plain
curve fit treats the obtuse corners of small gear teeth as bends and produces wavy lines, so in every
mode each traced polyline is first segmented into geometric primitives (`primitives.ts`):

- **Straight edges** (*Detect straight edges & corners*): total-least-squares line fits that stay
  within a pixel-level tolerance and do not bow. Adjacent edges meet at their exact intersection, so
  trapezoid teeth come out as 4 sharp nodes even at 130–160° corners. Corners blunted by
  rasterisation (or by thinning, in centerline mode) are restored, but only when the lines' meeting
  point lies as close to the bitmap as a blunted vertex would; rounded turns stay curves.
- **Circles and arcs** (*Fit circles & arcs*): algebraic (Kåsa) circle fit refined by Gauss–Newton.
  Holes and bores become exact circles (4 cubic quarter arcs); fillets become arcs that join edges
  tangentially. Arcs are exported as cubic Béziers of ≤ 90° each (max radial error ≈ 0.03 % of r).
- **Guards for organic artwork**: a shape is only called a polygon when a few sharp-turn lines explain
  it better than a circle; "lines" that are just flat stretches of a curve (ellipse ends) or that keep
  bending along their length are handed back to the free curve fit, and short lines must be anchored
  by hard corners at both ends. Everything else uses the regular Bézier fit.

The *Edges / arcs / circles* row in the output panel shows what was detected. Turn both toggles off
to get the previous pure-curve behaviour.

## How it works

All processing lives in `src/services` (pure TypeScript, no React) and runs in a Web Worker
(`src/workers/trace.worker.ts`):

- `imagePreprocessing` — luminance/darkest-channel intensity, alpha compositing, Otsu and adaptive
  thresholds, border flood-fill background removal, morphology, connected-component speck/hole removal.
- `contourDetection` — traces pixel-edge boundaries (8-connected foreground; outer contours clockwise,
  holes counter-clockwise) and nests holes in their enclosing shape.
- `curveFitting` — staircase → edge-midpoint polyline, uniform resampling, corner detection with
  arm-intersection refinement, Taubin smoothing (no shrinkage), Schneider least-squares cubic Bézier
  fitting, near-straight segments emitted as lines.
- `primitives` — segmentation into straight edges, circular arcs and free curves; line/circle
  intersections, tangent joins, exact circle output.
- `distanceTransform` — exact Euclidean distance transform (stroke radius per pixel).
- `skeleton` — allocation-free Zhang–Suen thinning and staircase removal.
- `centerline` — skeleton graph construction, pruning, junction merging, gap closing, stroke joining
  and end extension.
- `svgExporter` — SVG 1.1 with `viewBox` in source pixels, physical size in px/mm/in, even-odd fill,
  configurable precision. No `<image>` elements are ever written.

Large images are traced at the selected processing resolution (default 2400 px longest side) and
small images are upscaled; geometry is always mapped back to the original pixel dimensions.

### Notes and limitations

- OpenCV.js and Potrace were evaluated but not used: OpenCV.js adds ~8–10 MB of WASM for operations
  that are small to implement directly, and Potrace is GPL. The algorithms above are standard,
  dependency-free equivalents.
- Tracing is single-colour (one foreground layer). Multi-colour/posterized tracing is not implemented.
- Centerline works on strokes; large solid areas (filled shapes, very bold text) produce a medial
  axis rather than a meaningful line — use Outline or Silhouette for those. Variable-width strokes
  get one width per path, not a varying width along the path.
- Very sharp tips (< ~40°) may be blunted by up to ~1–2 px because of pixel aliasing.
- Primitive fitting recognises lines and circles only: ellipses, involute tooth flanks and splines are
  fitted as free curves. Features only a few pixels across (e.g. 6 px tooth tops) are recovered to
  ~1–1.5 px; use a higher processing resolution or a larger scan for tighter results. In centerline
  mode, corners land within ~2 px because the thinned skeleton itself rounds them.
- Small script lettering can still pick up a few extra corners with geometry on; turn the
  *Geometry* toggles off for purely organic artwork.
