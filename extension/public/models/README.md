# Bundled models

Everything here is loaded from disk at runtime. Nothing is fetched from a CDN
or any other network location — MUDRA's claim is that perception happens on
the device, and a runtime download would quietly make that untrue, as well as
failing on the locked-down networks these demos tend to run on.

These weights are the **only** binary committed to this repository. The ONNX
Runtime WASM binaries are not committed: they ship inside the
`onnxruntime-web` npm package, their version is pinned by `package-lock.json`,
and the Vite build copies them from `node_modules` into `dist/wasm/`. That
keeps multi-megabyte artefacts out of git history while still producing a
fully offline build.

---

## version-RFB-320.onnx — UltraFace-320

Face detection. Chosen because it is ~1.2 MB and runs comfortably in WASM on a
laptop CPU, which is the constraint the problem statement actually cares
about: a light-weight browser agent, not a datacentre.

| | |
|---|---|
| **Source** | https://github.com/onnx/models — `validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx`, branch `main` |
| **Upstream project** | [Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB) |
| **Licence** | MIT |
| **SHA-256** | `34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017` |
| **Size** | 1,270,727 bytes |
| **Retrieved** | 2026-09-23 |

Re-check at any time with `npm run verify:model`. The pre-flight check
compares the file on disk against the hash in this table and fails if they
differ, so a substituted or truncated download is caught before a demo rather
than during one.

### Tensors

Input — tensor name confirmed against the committed file, not assumed:

| Name | Type | Shape | Layout |
|---|---|---|---|
| `input` | float32 | `[1, 3, 240, 320]` | NCHW, channel-planar |

Preprocessing is mean 127, scale 1/128 — i.e. `(pixel - 127) / 128` per
channel, RGB order. See `normaliseToTensor` in `src/offscreen/vision.ts`.

Outputs:

| Name | Type | Shape | Meaning |
|---|---|---|---|
| `scores` | float32 | `[1, 4420, 2]` | per anchor, `(background, face)` |
| `boxes` | float32 | `[1, 4420, 4]` | per anchor, `(x1, y1, x2, y2)`, normalised to 0..1 |

`vision.ts` selects these by name rather than by position, falling back to
order if a re-export renamed them. A test asserts the names the loaded
session actually reports, so a model swap that changed them would fail loudly
instead of decoding the wrong tensor as boxes.

Box coordinates are normalised against the **original** image, not the
320x240 the model saw, so they scale by the capture's own dimensions. Post-
processing thresholds at 0.7, applies non-maximum suppression at IoU 0.3, and
pads each surviving box by 10% so hair and chin edges are covered.

### Recording the hash

```sh
npm run verify:model
```

This prints the SHA-256 and byte size of every file in this directory. Paste
the result into the table above. Recording a hash you have not computed
yourself defeats the point of recording one.

### If the file is missing

The pipeline fails closed. `initVision()` returns `{ ready: false, reason }`,
and the observation sends **no image at all**. There is deliberately no
fallback to sending the raw capture: an undetected face is an unmasked face,
so a detector that did not load is a reason to withhold pixels, never a reason
to send them.
