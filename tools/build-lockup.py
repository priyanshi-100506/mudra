#!/usr/bin/env python3
"""
Regenerates the MUDRA lockup assets.

The source art (docs/assets/mudra-lockup.svg) is an autotrace carrying a
*lowercase* "mudra" wordmark plus ~85KB of C2PA metadata. The brand lockup is
uppercase, so this script keeps the traced kolam — which is the part worth
preserving — and re-sets the wordmark as real type converted to outlines.

Wordmark and kolam are separated by bounding box, not by colour: the kolam's
counters are painted near-white just like the letter counters, so colour alone
cannot tell them apart.

Outputs (light ground, and a variant whose counters match the dark blue gradient's ground):
    extension/src/assets/mudra-lockup.svg
    extension/src/assets/mudra-lockup-dark.svg
    backend/app/static/{same two}

Run:  .venv/bin/python tools/build-lockup.py
"""
import re
import pathlib
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs/assets/mudra-lockup.svg"
FONT = "/System/Library/Fonts/Supplemental/Impact.ttf"
WORD = "MUDRA"

NAVY = "#160B69"
GROUND_DARK = "#0E0840"
KOLAM_DARK = "#8FA0E0"
NAVY_DARK = "#FFFFFF"

# Bounding box of the traced lowercase wordmark in the source art.
WX0, WY0, WX1, WY1 = 326, 387, 866, 638


def luminance(hexcolour: str) -> float:
    r, g, b = (int(hexcolour[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def kolam_paths(svg: str) -> str:
    """The kolam: every path that is not part of the old lowercase wordmark.

    Anything sitting entirely inside the old wordmark's bounding box is
    dropped, whatever its colour — that box was opaque in the source art, so
    nothing visible is lost. The one exception is a near-white path that falls
    inside a kolam petal we are keeping: those are the petal's counters, and
    removing them leaves the petal painted solid.
    """
    entries = []
    for match in re.finditer(r"<path[^>]*/>", svg):
        path = match.group(0)
        fill = re.search(r'fill="(#[0-9A-Fa-f]{6})"', path)
        data = re.search(r'd="([^"]*)"', path)
        shift = re.search(r"translate\((-?[\d.]+),(-?[\d.]+)\)", path)
        if not (fill and data and shift):
            continue
        tx, ty = float(shift.group(1)), float(shift.group(2))
        nums = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", data.group(1))]
        xs, ys = nums[0::2], nums[1::2]
        box = (tx + min(xs), ty + min(ys), tx + max(xs), ty + max(ys))
        entries.append((box, luminance(fill.group(1).upper()), path))

    def behind_wordmark(b):
        return b[0] >= WX0 - 2 and b[2] <= WX1 + 2 and b[1] >= WY0 - 2 and b[3] <= WY1 + 2

    kept_line = [b for b, light, _ in entries
                 if 60 <= light <= 200 and not behind_wordmark(b)]

    def encloses(outer, inner):
        return (outer[0] <= inner[0] and outer[1] <= inner[1]
                and outer[2] >= inner[2] and outer[3] >= inner[3])

    keep = []
    for box, light, path in entries:
        if light < 60:                       # the navy wordmark
            continue
        if behind_wordmark(box):
            counter_of_kept = light > 200 and any(encloses(o, box) for o in kept_line)
            if not counter_of_kept:
                continue
        keep.append(path)
    return "".join(keep)


def wordmark() -> str:
    font = TTFont(FONT)
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    parts, cursor, bounds = [], 0, BoundsPen(glyphs)
    for char in WORD:
        name = cmap[ord(char)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, cursor, 0)))
        parts.append(pen.getCommands())
        glyphs[name].draw(TransformPen(bounds, (1, 0, 0, -1, cursor, 0)))
        cursor += glyphs[name].width
    x0, y0, x1, y1 = bounds.bounds
    # Uniform scale: fit the original wordmark width and keep the letterforms
    # undistorted, then sit on the original baseline.
    scale = (WX1 - WX0) / (x1 - x0)
    top = WY1 - (y1 - y0) * scale
    return (f'<g transform="translate({WX0},{top}) scale({scale:.5f}) '
            f'translate({-x0},{-y0})"><path d="{" ".join(parts)}" fill="{NAVY}"/></g>')


def recolour_for_dark(svg: str) -> str:
    def sub(match):
        value = match.group(1).upper()
        light = luminance(value)
        if light > 200:
            return f'fill="{GROUND_DARK}"'   # counters take the page ground
        if light < 60:
            return f'fill="{NAVY_DARK}"'     # the wordmark
        return f'fill="{KOLAM_DARK}"'        # the kolam line
    return re.sub(r'fill="(#[0-9A-Fa-f]{6})"', sub, svg)


def main() -> None:
    raw = SOURCE.read_text()
    raw = re.sub(r"<metadata>.*?</metadata>", "", raw, flags=re.S)
    raw = re.sub(r"-?\d+\.\d+",
                 lambda m: f"{round(float(m.group(0)), 2):g}", raw)

    body = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="139 267 752 502" '
            f'role="img" aria-label="Mudra">{kolam_paths(raw)}{wordmark()}</svg>')
    dark = recolour_for_dark(body)

    for directory in (ROOT / "extension/src/assets", ROOT / "backend/app/static"):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "mudra-lockup.svg").write_text(body)
        (directory / "mudra-lockup-dark.svg").write_text(dark)
    print(f"lockup {len(body):,} bytes  ({body.count('<path')} paths)")


if __name__ == "__main__":
    main()
