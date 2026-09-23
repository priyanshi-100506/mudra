# Tesseract language data

`eng.traineddata` and `hin.traineddata` are **committed here**, and loaded
from disk at runtime.

## Why they are committed

Tesseract.js fetches language data from a CDN on first use by default. That
default is switched off in `src/offscreen/tesseract-engine.ts` — the first
scanned Aadhaar card the agent saw would otherwise cause a network request at
the moment it was seen, which is the exact opposite of what MUDRA claims.

With the fetch off, the data has to come from somewhere, and the honest
reason it is in git rather than in a setup step is the demo. A judge may
clone this repo; we may be setting up on a borrowed laptop behind conference
wifi. The fail-closed path is deliberately aggressive — no OCR means every
image region is masked whole — so a missing file would not produce an error,
it would produce a Hindi OCR demo that silently does nothing at the worst
possible moment.

About 5 MB of Apache-licensed data is a fair price for a demo that cannot
fail that way. The fail-closed path is unchanged and still tested; it just
should not be the path the demo takes.

These are the only committed binaries besides the ONNX weights. The ONNX
Runtime and Tesseract WASM binaries are *not* committed — they ship in their
npm packages, are pinned by `package-lock.json`, and are copied out of
`node_modules` at build time.

## Provenance

The `_fast` variants: a few MB each rather than tens, at a small accuracy
cost on clean document scans, which is exactly what ID cards are.

| | |
|---|---|
| **Source** | https://github.com/tesseract-ocr/tessdata_fast (`main`) |
| **Licence** | Apache 2.0 |
| **Retrieved** | 2026-09-23 |

| File | SHA-256 | Size |
|---|---|---|
| `eng.traineddata` | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` | 4,113,088 bytes |
| `hin.traineddata` | `4c73ffc59d497c186b19d1e90f5d721d678ea6b2e277b719bee4e2af12271825` | 1,122,751 bytes |

Re-check with `shasum -a 256 *.traineddata`.

## Why Hindi

Aadhaar and PAN cards, and most central and state government portals, carry
Devanagari. An English-only reader misses the labels that mark a document as
an ID card in the first place, so it would fail on precisely the documents
this project exists to protect.

## If the data is missing anyway

The pipeline still fails closed, and in a specific way worth understanding:
OCR being unavailable does not mean image regions are ignored. It means every
image region is masked **whole**, because a region nobody read is a region
whose contents nobody can vouch for. The agent still works; it sees less of
the page. It never sends an unread region in the clear.
