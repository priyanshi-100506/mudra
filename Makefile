# MUDRA
#
# Thin wrappers. The real work is in scripts/demo.mjs, which is Node rather
# than shell so that Windows is not stranded — Node is already required for
# the extension build.

.PHONY: demo build test eval clean

## Bring up backend, fixtures and a fresh extension build.
demo:
	node scripts/demo.mjs

## Build the extension.
build:
	cd extension && npm run build

## Both suites.
test:
	cd extension && npm test
	cd backend && python -m pytest ../tests -q

## Re-run the evaluation and rewrite eval/results.json.
eval:
	cd extension && npm run eval

clean:
	rm -rf extension/dist
