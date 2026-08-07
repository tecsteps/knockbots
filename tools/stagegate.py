#!/usr/bin/env python3
"""stagegate — a committed, re-derivable instrument for the Stage-detail axis.

Why this file exists
--------------------
Round 30 found that the periodicity figures every previous stage round was
launched on ("pit 0.306 -> 0.188, skydeck 0.250 -> 0.251, cistern 0.413 ->
0.411") exist nowhere in the repo: no tool, no log, no definition. They cannot
be reproduced, so they cannot be compared against. This file replaces them with
a definition you can run.

Everything here is LOCALISED (named pixel rectangles, listed below),
EQUALISED (both codec and true render resolution), and reported as a
DISTRIBUTION over the reference patches rather than as "the reference".

Three numbers per floor patch:

  P  tiling periodicity, 0..1
     High-pass the patch (subtract a sigma=16 Gaussian) to kill the lighting
     and perspective gradient, normalise to unit variance, take the normalised
     2-D autocorrelation, mask out the central lobe (|lag| < 12 px) and report
     the maximum remaining value. A surface stamped from one repeated tile
     scores high; a surface where every slab differs scores low.

  D  detail density
     RMS gradient magnitude of log-luma over the patch. Contrast-relative, so
     a dark patch is not punished for being dark.

  U  detail-density uniformity  (whole frame, not the patch)
     Coefficient of variation of high-frequency energy across a 12x6 tile grid
     over rows 260..960. "Uniform detail density" is a named failure mode on
     this axis; a composed frame has foreground clutter, a busy midground and
     a smooth sky, so its CoV is high.

  FARNEAR  atmospheric falloff
     RMS high-pass energy in the far band divided by the near band. AAA stages
     attenuate far detail with atmosphere; a skybox-and-plane does not.

EQUALISATION, both directions, because both have burned a round:
  * codec — ours are PNG (0 generations), references are JPEG at 2.5-5.1 bpp.
    Un-equalised this inflates our top-band energy. `--equalise codec` re-encodes
    each of our patches to the reference median bpp before measuring.
  * resolution — our captures are written at 1920x1080 but RENDERED at an
    adaptive scale (see shots/manifest.json: 0.72-0.85 for the wide shots) and
    upscaled. The file resolution matches the references; the rendered
    resolution does not. `--equalise res` downsamples every patch by the
    weakest true render scale in the set so no patch carries more real pixels
    than the weakest.

Usage:
  python3 tools/stagegate.py report            # both raw and equalised
  python3 tools/stagegate.py report --json out.json
"""
import argparse, io, json, math, os, sys
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --- localisation -----------------------------------------------------------
# Floor patches, (x0, y0, x1, y1) in native 1920x1080 coordinates.
# Ours: taken away from both fighters so a character body cannot enter the
# patch. References: only frames with an in-focus floor qualify.
PATCHES = {
    # ours
    "ours/pit":     ("shots/06-stage-wide.png",    (180, 700, 780, 1000), 0.85),
    "ours/skydeck": ("shots/18-skydeck-wide.png",  (180, 700, 780, 1000), 0.84),
    "ours/cistern": ("shots/19-cistern-wide.png",  (150, 720, 750, 1020), 0.72),
    # references. tekken8_07 is the only WIDE IN-MATCH frame with an unobscured
    # floor -- it is the only strictly frame-matched comparison in the whole set.
    "ref/07a":      ("ref/tekken8/tekken8_07.jpg", (120, 760, 720, 1060), 1.0),
    "ref/07b":      ("ref/tekken8/tekken8_07.jpg", (1150, 780, 1750, 1080), 1.0),
    # widened floor-bearing set, NOT frame-matched: 08 is a mid-shot on an
    # arena mat, 10 is the hub screen. Reported separately, never merged into
    # the frame-matched number without saying so.
    "ref/08a":      ("ref/tekken8/tekken8_08.jpg", (60, 830, 660, 1080), 1.0),
    "ref/08b":      ("ref/tekken8/tekken8_08.jpg", (1300, 830, 1900, 1080), 1.0),
    "ref/10a":      ("ref/tekken8/tekken8_10.jpg", (150, 780, 750, 1030), 1.0),
    "ref/10b":      ("ref/tekken8/tekken8_10.jpg", (1150, 800, 1750, 1050), 1.0),
}
FRAME_MATCHED_REFS = ["ref/07a", "ref/07b"]
WIDENED_REFS = FRAME_MATCHED_REFS + ["ref/08a", "ref/08b", "ref/10a", "ref/10b"]
# Discarded, with the reason, so the discard is auditable:
DISCARDED = {
    "tekken8_02": "wide in-match, but the entire floor is under water-spray VFX",
    "tekken8_06": "super cinematic, background dissolved to a vortex -- no floor",
    "tekken8_01/03/04/05/09": "closeups with defocused backdrops -- no in-focus floor",
}

# Whole-frame shots for U and FARNEAR.
FRAMES = {
    "ours/pit":     ("shots/06-stage-wide.png",   0.85),
    "ours/skydeck": ("shots/18-skydeck-wide.png", 0.84),
    "ours/cistern": ("shots/19-cistern-wide.png", 0.72),
    "ref/02":       ("ref/tekken8/tekken8_02.jpg", 1.0),
    # ref/06 IS NOT HERE, AND THE DISCARDED DICT ABOVE ALREADY SAID SO.
    #
    # It was listed here for whole-frame U and FARNEAR while sitting three lines
    # above in DISCARDED as "super cinematic, background dissolved to a vortex --
    # no floor", and while docs/CRITIC.md's per-image classification -- written by
    # opening every file -- marks it NO STAGE AT ALL. So the stage axis was
    # computing whole-frame statistics against an image with no stage in it,
    # after the correction had been written down twice.
    #
    # That is this project's most repeated failure and it is not a measurement
    # error: the finding was correct, recorded, and never carried into the code.
    # A discard list that the frame list does not honour is decoration.
    "ref/07":       ("ref/tekken8/tekken8_07.jpg", 1.0),
}
# Stated here because every consumer of FRAMES needs it: the stage reference
# population is n=1-2 in-match floors, and ref/07 is the known 2.1x density
# outlier. Report both values. Never min/median/max as "the reference".
HUD_SAFE_TOP = 260      # the protocol's 175 does NOT clear the round banner or
HUD_SAFE_BOT = 960      # the combo counter; both are still inside 175..960.


def luma(rgb):
    a = np.asarray(rgb, dtype=np.float64) / 255.0
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def bpp(path):
    with Image.open(path) as im:
        w, h = im.size
    return os.path.getsize(path) * 8.0 / (w * h)


def jpeg_at_bpp(im, target_bpp, lo=30, hi=97):
    """Re-encode `im` at the JPEG quality whose bitrate is closest to target."""
    best, bestq, bestd = im, hi, 1e9
    for _ in range(8):
        q = (lo + hi) // 2
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=q, subsampling=1)
        b = buf.tell() * 8.0 / (im.size[0] * im.size[1])
        d = abs(b - target_bpp)
        if d < bestd:
            bestd, bestq = d, q
            buf.seek(0)
            best = Image.open(buf).convert("RGB")
            best.load()
        if b < target_bpp:
            lo = q + 1
        else:
            hi = q - 1
        if lo > hi:
            break
    return best, bestq


def periodicity(L, exclude=12):
    x = L - gaussian_filter(L, 16.0)
    s = x.std()
    if s < 1e-8:
        return 0.0
    x = (x - x.mean()) / s
    F = np.fft.rfft2(x)
    ac = np.fft.irfft2(F * np.conj(F), s=x.shape)
    ac = np.fft.fftshift(ac) / ac.max()
    cy, cx = ac.shape[0] // 2, ac.shape[1] // 2
    yy, xx = np.ogrid[:ac.shape[0], :ac.shape[1]]
    r2 = (yy - cy) ** 2 + (xx - cx) ** 2
    m = r2 >= exclude ** 2
    # ignore the outermost 15% of lags where the overlap area is tiny and noisy
    m &= r2 <= (0.425 * min(ac.shape)) ** 2
    return float(ac[m].max())


def detail(L):
    lg = np.log(np.clip(L, 1e-3, None))
    gy, gx = np.gradient(lg)
    return float(np.sqrt((gy ** 2 + gx ** 2).mean()))


def hf(L):
    return float((L - gaussian_filter(L, 2.0)).std())


def uniformity(L, nx=12, ny=6):
    h, w = L.shape
    e = []
    for j in range(ny):
        for i in range(nx):
            t = L[j * h // ny:(j + 1) * h // ny, i * w // nx:(i + 1) * w // nx]
            e.append(hf(t))
    e = np.array(e)
    return float(e.std() / max(e.mean(), 1e-9)), float(np.median(e))


def farnear(L):
    h = L.shape[0]
    far = L[: h // 3]
    near = L[2 * h // 3:]
    return float(hf(far) / max(hf(near), 1e-9))


def load_patch(key, equalise, ref_bpp, min_scale):
    rel, box, scale = PATCHES[key]
    p = os.path.join(ROOT, rel)
    im = Image.open(p).convert("RGB").crop(box)
    q = None
    if "codec" in equalise and rel.endswith(".png"):
        im, q = jpeg_at_bpp(im, ref_bpp)
    if "res" in equalise:
        # A w-wide crop from a frame rendered at `scale` and upscaled to 1920
        # contains only w*scale genuinely rendered pixels. Resampling every
        # patch to w*min_scale leaves each carrying the same true pixel count,
        # equal to the weakest capture in the set.
        w, h = im.size
        im = im.resize((max(8, int(round(w * min_scale))),
                        max(8, int(round(h * min_scale)))), Image.BOX)
    return im, q


def run(equalise):
    ref_bpps = [bpp(os.path.join(ROOT, PATCHES[k][0])) for k in WIDENED_REFS]
    ref_bpp = float(np.median(ref_bpps))
    min_scale = min(s for (_, _, s) in PATCHES.values() if s < 1.0)
    out = {"equalise": sorted(equalise), "refMedianBpp": round(ref_bpp, 3),
           "minTrueRenderScale": min_scale, "patches": {}, "frames": {}}
    for k in PATCHES:
        im, q = load_patch(k, equalise, ref_bpp, min_scale)
        L = luma(im)
        out["patches"][k] = {"px": list(im.size), "P": round(periodicity(L), 4),
                             "D": round(detail(L), 4), "HF": round(hf(L), 4),
                             "jpegQ": q}
    for k, (rel, scale) in FRAMES.items():
        im = Image.open(os.path.join(ROOT, rel)).convert("RGB").crop(
            (0, HUD_SAFE_TOP, 1920, HUD_SAFE_BOT))
        if "codec" in equalise and rel.endswith(".png"):
            im, _ = jpeg_at_bpp(im, ref_bpp)
        if "res" in equalise:
            im = im.resize((int(1920 * min_scale), int((HUD_SAFE_BOT - HUD_SAFE_TOP) * min_scale)), Image.BOX)
        L = luma(im)
        u, med = uniformity(L)
        out["frames"][k] = {"U": round(u, 4), "tileMedianHF": round(med, 5),
                            "farNear": round(farnear(L), 4)}
    return out


def dist(vals):
    v = sorted(vals)
    return {"min": round(v[0], 4), "median": round(float(np.median(v)), 4),
            "max": round(v[-1], 4), "n": len(v)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["report"])
    ap.add_argument("--json")
    a = ap.parse_args()
    res = {"raw": run(set()), "equalised": run({"codec", "res"})}
    for mode in ("raw", "equalised"):
        r = res[mode]
        print(f"\n=== {mode}  (refMedianBpp={r['refMedianBpp']}, "
              f"minTrueRenderScale={r['minTrueRenderScale']})")
        print(f"{'patch':16s} {'px':>10s} {'P':>8s} {'D':>8s} {'HF':>8s}")
        for k, v in r["patches"].items():
            print(f"{k:16s} {str(v['px']):>10s} {v['P']:8.4f} {v['D']:8.4f} {v['HF']:8.4f}")
        fm = [r["patches"][k]["P"] for k in FRAME_MATCHED_REFS]
        wd = [r["patches"][k]["P"] for k in WIDENED_REFS]
        print(f"  ref P frame-matched {dist(fm)}")
        print(f"  ref P widened       {dist(wd)}")
        print(f"{'frame':16s} {'U':>8s} {'medHF':>9s} {'far/near':>9s}")
        for k, v in r["frames"].items():
            print(f"{k:16s} {v['U']:8.4f} {v['tileMedianHF']:9.5f} {v['farNear']:9.4f}")
    print("\ndiscarded references:")
    for k, why in DISCARDED.items():
        print(f"  {k}: {why}")
    if a.json:
        json.dump(res, open(a.json, "w"), indent=1)
        print("\nwrote", a.json)


if __name__ == "__main__":
    main()
