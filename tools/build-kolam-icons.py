#!/usr/bin/env python3
"""
Generates the MUDRA extension icons: a pulli kolam on a diamond dot grid.

The motif is constructed, not traced. Each dot gets a diamond cell; a vertex
shared with a neighbouring cell stays sharp so the two cells' edges chain into
one continuous 45 degree line, and a vertex on the outer boundary is rounded,
which is what reads as the kolam's petal. That single rule produces the whole
figure — woven lattice inside, petals around the edge.

Run:  .venv/bin/python tools/build-kolam-icons.py
"""
import math, sys, pathlib, subprocess, tempfile

def cell_path(cx, cy, R, corner_r):
    """One kolam cell: a diamond of radius R around a dot.

    Corner radii are given per vertex. A vertex shared with a neighbouring
    cell stays sharp, so the two cells' edges chain into one continuous 45
    degree line; a vertex on the outer boundary is rounded, which is what
    reads as the kolam's petal.
    """
    P = [(cx+R, cy), (cx, cy+R), (cx-R, cy), (cx, cy-R)]
    n = len(P)
    d = []
    start = None
    for k in range(n):
        x0, y0 = P[k]
        xp, yp = P[(k-1) % n]
        xn, yn = P[(k+1) % n]
        r = corner_r[k]
        # unit vectors from this vertex toward its two neighbours
        def unit(ax, ay, bx, by):
            vx, vy = bx-ax, by-ay
            L = math.hypot(vx, vy)
            return vx/L, vy/L
        upx, upy = unit(x0, y0, xp, yp)
        unx, uny = unit(x0, y0, xn, yn)
        a = (x0 + upx*r, y0 + upy*r)      # arrive here
        b = (x0 + unx*r, y0 + uny*r)      # leave from here
        if start is None:
            start = a
            d.append(f"M{a[0]:.2f},{a[1]:.2f}")
        else:
            d.append(f"L{a[0]:.2f},{a[1]:.2f}")
        if r > 0.01:
            d.append(f"A{r:.2f},{r:.2f} 0 0 1 {b[0]:.2f},{b[1]:.2f}")
        else:
            d.append(f"L{b[0]:.2f},{b[1]:.2f}")
    d.append("Z")
    return " ".join(d)

def build(N=4, s=104, round_frac=0.62, stroke=2.3,
          line="#C9C6F5", bg="#222226", dot_r=3.3):
    dots = {(i, j) for j in range(-N, N+1)
                   for i in range(-(N-abs(j)), N-abs(j)+1)}
    R = s/2
    rr = R*round_frac
    ext = N*s + R + s*0.55
    vb = f"{-ext:.0f} {-ext:.0f} {2*ext:.0f} {2*ext:.0f}"
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="Mudra">']
    if bg:
        o.append(f'<rect x="{-ext:.0f}" y="{-ext:.0f}" width="{2*ext:.0f}" height="{2*ext:.0f}" fill="{bg}"/>')
    o.append(f'<g fill="none" stroke="{line}" stroke-width="{stroke:.2f}" stroke-linejoin="round">')
    # vertex k order: +x, +y, -x, -y  ->  neighbour that shares it
    nbr = [(1, 0), (0, 1), (-1, 0), (0, -1)]
    for (i, j) in sorted(dots):
        radii = [0.0 if (i+dx, j+dy) in dots else rr for (dx, dy) in nbr]
        o.append(f'<path d="{cell_path(i*s, j*s, R, radii)}"/>')
    o.append('</g>')
    o.append(f'<g fill="{line}">')
    for (i, j) in sorted(dots):
        o.append(f'<circle cx="{i*s}" cy="{j*s}" r="{dot_r}"/>')
    o.append('</g></svg>')
    return "\n".join(o)

GROUND = ('<defs><linearGradient id="g" x1="0" y1="0" x2="0.55" y2="1">'
          '<stop offset="0" stop-color="#0A3A57"/><stop offset="1" stop-color="#0369A1"/>'
          '</linearGradient></defs>')

# Optical sizing: the full 41-dot lattice is a smudge below about 128px, so the
# smaller icons carry a reduced one drawn at a heavier weight. Same motif, same
# construction, legible at every size Chrome asks for.
PLAN = {16: (1, 11.0, 11.0), 32: (2, 7.5, 8.0), 48: (2, 7.5, 8.0), 128: (4, 4.2, 4.6)}


def tile(N, stroke, dot_r):
    svg = build(N=N, stroke=stroke, dot_r=dot_r, line="#FFFFFF", bg=None)
    x, y, w, h = svg.split('viewBox="')[1].split('"')[0].split()
    return svg.replace(">", ">" + GROUND +
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="url(#g)"/>', 1)


def main() -> None:
    from PIL import Image
    root = pathlib.Path(__file__).resolve().parent.parent
    out = root / "extension/src/icons"
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        for size, (N, stroke, dot_r) in PLAN.items():
            src = tmp / f"k{size}.svg"
            src.write_text(tile(N, stroke, dot_r))
            subprocess.run(["qlmanage", "-t", "-s", "512", "-o", str(tmp), str(src)],
                           capture_output=True, check=False)
            png = tmp / f"{src.name}.png"
            if not png.exists():
                raise SystemExit(f"render failed for {size}px")
            Image.open(png).convert("RGBA").resize((size, size), Image.LANCZOS) \
                 .save(out / f"icon-{size}.png")
            print(f"icon-{size}.png  (lattice N={N})")


if __name__ == "__main__":
    main()
