# MUDRA
#
# Thin wrappers. The real work is in scripts/demo.mjs, which is Node rather
# than shell so that Windows is not stranded — Node is already required for
# the extension build.

.PHONY: demo build test eval drive preflight clean

## Bring up backend, fixtures and a fresh extension build.
demo:
	node scripts/demo.mjs

## Build the extension.
build:
	cd extension && npm run build

# The virtualenv's python, wherever this platform put it. A bare `python`
# here resolves to whatever is on PATH, which is usually not the venv, and
# the failure looks like a missing dependency rather than a missing venv.
PY := $(firstword $(wildcard .venv/bin/python .venv/Scripts/python.exe backend/.venv/bin/python) python3)

## Both suites.
test:
	cd extension && npm test
	cd backend && ../$(PY) -m pytest ../tests -q

## Check everything before going on stage. Green or red, per line.
preflight:
	cd extension && npm run preflight

## Load the built extension into a real Chrome and drive it.
drive:
	cd extension && npm run build && npm run drive

## Re-run the evaluation and rewrite eval/results.json.
## The visual half needs a browser and a fixture server: run `make demo` first.
eval:
	cd extension && npm run eval
	cd extension && npm run eval:visual
	cd extension && npm run measure:payload

clean:
	rm -rf extension/dist
