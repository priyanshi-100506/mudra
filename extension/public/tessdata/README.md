# Tesseract language data

`eng.traineddata.gz` and `hin.traineddata.gz` belong in this directory.

They are **not committed**, and they are **not in npm**. Unlike the ONNX
Runtime and Tesseract WASM binaries — which ship inside their packages and are
copied out of `node_modules` at build time — Tesseract's language data is
normally fetched from a CDN at first use. That default is switched off in
`src/offscreen/tesseract-engine.ts`: the first scanned Aadhaar card the agent
saw would otherwise cause a network request at the moment it was seen, which
is the exact opposite of what MUDRA claims.

So the data is loaded from here, on disk, and you place it yourself.

## Getting it

From [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) (Apache
2.0). The `_fast` variants are the right trade for this: a few MB each rather
than tens, at a small accuracy cost on clean document scans, which is what ID
cards are.

```sh
cd extension/public/tessdata
curl -LO https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
curl -LO https://github.com/tesseract-ocr/tessdata_fast/raw/main/hin.traineddata
gzip -k eng.traineddata hin.traineddata
```

Check what you downloaded before you trust it — `shasum -a 256 *.traineddata`
against the upstream release.

## Why Hindi

Aadhaar and PAN cards, and most central and state government portals, carry
Devanagari. An English-only reader misses the labels that mark a document as
an ID card in the first place, so it would fail on precisely the documents
this project exists to protect.

## If the data is missing

The pipeline fails closed, and in a specific way worth understanding: OCR
being unavailable does not mean image regions are ignored. It means every
image region is masked **whole**, because a region nobody read is a region
whose contents nobody can vouch for. The agent still works; it just sees less
of the page. It never sends an unread region in the clear.
