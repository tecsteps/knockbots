#!/usr/bin/env python3
"""Impact & effects gate — the measurement behind the impact axis score.

Round 28 note: this file exists because the round-27 handover quoted a gate
("discrete particle count 11-29 -> 35-152, size p90 under 35px, ink ladder
1.81x") with NO committed script defining ink, particle, or the ROI. None of
those three numbers could be re-derived. A gate whose measurement is not in the
repo is not a gate. Everything below is explicit so the next round can disagree
with the definition rather than with the arithmetic.

Definitions
  ROI        fractional (y0,y1,x0,x1) of the frame, so 720p and 1080p captures
             compare. NEVER pixel coords -- the round-27 baseline is 1280x720
             and the current set is 1920x1080; a pixel ROI silently measures
             background on one of them and reports 0 particles.
  effect ink pixels with Rec.709 luma > 0.90, as a % of ROI area.
  particle   4-connected-or-better component of that mask with area >= 4px.
  size       max(bbox height, bbox width) of a component, in px.
  hue IQR    interquartile spread, in degrees, of the hue of pixels with
             luma > 0.85. Measures whether the effect is one colour or many.

Controls that must stay clean or the number means nothing:
  - a no-effect ROI in the same frame must read ~0 ink (KB ctrl reads 0.000);
  - comparing across resolutions requires the resample round-trip control
    (--control), which reports how much of any delta is just the resampler.

usage: python3 tools/fxgate.py [--control]
"""
import io
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

REPO = __file__.rsplit("/tools/", 1)[0] + "/"

# Contact ROIs, fractional. 15/16 share a camera (verified: mean abs diff over a
# far-background patch is 0.005 between them, 0.11-0.15 against every other
# shot), so they are the only weight-ladder pair in the set that is camera-
# matched. 04-impact is a DIFFERENT camera -- any light->launcher ratio crosses
# framing scale and background luminance and is not a weight measurement.
ROIS = {
    "15-impact-light": (0.352, 0.796, 0.458, 0.688),
    "16-impact-heavy": (0.352, 0.796, 0.458, 0.688),
    "04-impact":       (0.278, 0.833, 0.365, 0.781),
    "04b-impact-decay":(0.278, 0.833, 0.365, 0.781),
    "07-super":        (0.162, 0.889, 0.000, 1.000),
}

# Reference, comparable subset only. Six of the ten refs are closeups with
# defocused backdrops and carry no impact effect at all; tekken8_07 is a wide
# but has no impact in frame; tekken8_10 is a hub screen. Two survive.
REF = {
    "tekken8_02": (0.352, 0.944, 0.443, 0.729),   # in-match wide, contact
    "tekken8_06": (0.185, 0.889, 0.156, 0.573),   # rage-art cinematic, contact
}

CTRL = {   # no-effect ROI in the same frames; must read ~0 ink
    "15-impact-light": (0.352, 0.796, 0.078, 0.307),
    "tekken8_02":      (0.352, 0.944, 0.078, 0.365),
}


def luma(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def hue(a):
    mx, mn = a.max(-1), a.min(-1)
    d = mx - mn + 1e-6
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return np.where(mx == r, (g - b) / d % 6,
                    np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60


def measure(img, froi, jpeg_q=60):
    """jpeg_q normalises PNG captures against JPEG baselines. Skipping it makes
    a PNG look like it has more fine particles than a JPEG of the same frame."""
    if jpeg_q:
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=jpeg_q)
        img = Image.open(buf)
    a = np.asarray(img.convert("RGB")).astype(np.float32) / 255
    h, w = a.shape[:2]
    y0, y1, x0, x1 = int(froi[0] * h), int(froi[1] * h), int(froi[2] * w), int(froi[3] * w)
    s = a[y0:y1, x0:x1]
    lum = luma(s)
    m = lum > 0.90
    lab, n = ndimage.label(m, structure=np.ones((3, 3)))
    if n:
        areas = np.array(ndimage.sum(m, lab, range(1, n + 1)))
        objs = ndimage.find_objects(lab)
        dims = np.array([max(o[0].stop - o[0].start, o[1].stop - o[1].start) for o in objs])
        keep = areas >= 4
        areas, dims = areas[keep], dims[keep]
    else:
        areas = dims = np.array([])
    bright = lum > 0.85
    hq = np.percentile(hue(s)[bright], [25, 75]) if bright.sum() else [0.0, 0.0]
    return {
        "ink": float(m.mean() * 100),
        "n": int(len(areas)),
        "dim_p90": float(np.percentile(dims, 90)) if len(dims) else 0.0,
        "hue_iqr": float(hq[1] - hq[0]),
        "peak": float(lum.max()),
        "clip": float((lum >= 0.999).mean()),
    }


def show(name, r):
    print("  %-18s ink=%6.3f%%  N=%4d  dimP90=%5.1f  hueIQR=%6.1f  peak=%.4f  clip=%.5f"
          % (name, r["ink"], r["n"], r["dim_p90"], r["hue_iqr"], r["peak"], r["clip"]))


def open_shot(name):
    for ext, sub in ((".png", "shots/"), (".jpg", "shots/"), (".jpg", "ref/tekken8/")):
        try:
            return Image.open(REPO + sub + name + ext)
        except OSError:
            continue
    raise SystemExit("missing capture: " + name)


def main():
    print("KNOCKBOTS — impact contact ROIs")
    kb = {}
    for k, roi in ROIS.items():
        kb[k] = measure(open_shot(k), roi)
        show(k, kb[k])

    print("\nREFERENCE — comparable subset only (n=2; the other eight are closeups,")
    print("a no-impact wide, and a hub screen, and are excluded, not averaged in)")
    ref = {}
    for k, roi in REF.items():
        ref[k] = measure(open_shot(k), roi)
        show(k, ref[k])

    print("\nCONTROLS — no-effect ROI, must read ~0 ink")
    for k, roi in CTRL.items():
        show(k + " ctrl", measure(open_shot(k), roi))

    print("\nDISTRIBUTION over the comparable subset (min / median / max):")
    for f, lbl in (("n", "particle count"), ("dim_p90", "element size p90"),
                   ("hue_iqr", "hue IQR (deg)"), ("peak", "peak luma")):
        v = sorted(r[f] for r in ref.values())
        print("  %-18s %8.2f / %8.2f / %8.2f   |  KB 16-impact-heavy %8.2f"
              % (lbl, v[0], float(np.median(v)), v[-1], kb["16-impact-heavy"][f]))

    print("\nWEIGHT LADDER — camera-matched pair only (15 vs 16)")
    print("  light->heavy ink %.2fx  (damage 11.5 -> 40.25 = 3.50x)"
          % (kb["16-impact-heavy"]["ink"] / kb["15-impact-light"]["ink"]))
    print("  light->launcher NOT MEASURABLE: 04-impact is a different camera.")

    print("\nDECAY — 04-impact -> 04b (+8 ticks)")
    print("  ink %.3f%% -> %.3f%% (%.0f%% remaining), hue IQR %.1f -> %.1f deg"
          % (kb["04-impact"]["ink"], kb["04b-impact-decay"]["ink"],
             100 * kb["04b-impact-decay"]["ink"] / kb["04-impact"]["ink"],
             kb["04-impact"]["hue_iqr"], kb["04b-impact-decay"]["hue_iqr"]))

    if "--control" in sys.argv:
        print("\nRESAMPLE CONTROL — how much of a cross-resolution delta is the resampler")
        for k, roi in ROIS.items():
            im = open_shot(k).convert("RGB")
            a = measure(im, roi)
            rt = im.resize((1280, 720), Image.LANCZOS).resize((1920, 1080), Image.LANCZOS)
            b = measure(rt, roi)
            print("  %-18s N %4d -> %4d through 720p  (bias %+.0f%%)"
                  % (k, a["n"], b["n"], 100 * (b["n"] - a["n"]) / max(a["n"], 1)))


if __name__ == "__main__":
    main()
