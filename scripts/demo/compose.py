#!/usr/bin/env python3
"""
Turns a recording from record.mjs into a looped animated WebP for the blog.

  python3 -I scripts/demo/compose.py <recording-dir> <scene.json> <out.webp>

The scene's "camera" list zooms and pans: each key names a mark (or a time in
ms) and a rect in terminal cells [col, row, cols, rows] ("full" for the whole
screen); the camera eases to it over "dur" ms. "fast" ranges ([from-mark,
to-mark, speed]) play model waits faster, with a badge saying so.
"""
import json
import sys
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

rec, scene_file, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
tl = json.loads((rec / "timeline.json").read_text())
scene = json.loads(scene_file.read_text())
cols, rows = tl["cols"], tl["rows"]
marks = {m["name"]: m["t"] for m in tl["marks"]}
frames = tl["frames"]


def at(x):
    """A mark's time (None if the recording skipped it) or a time in ms."""
    return marks.get(x) if isinstance(x, str) else float(x)


src0 = Image.open(rec / frames[0]["file"])
SW, SH = src0.size
CW, CH = SW / cols, SH / rows

# Canvas: a window on a dark backdrop, sized for a 672 px blog column at 2x.
W = int(scene.get("width", 1344))
PAD = 40
BAR = 44
CONTENT_W = W - 2 * PAD
CONTENT_H = round(CONTENT_W * SH / SW)
H = CONTENT_H + BAR + 2 * PAD
ASPECT = CONTENT_W / CONTENT_H
BG_TOP, BG_BOTTOM = (20, 20, 24), (30, 29, 36)
FPS = int(scene.get("fps", 25))

font_path = str(Path(__file__).resolve().parents[2] / "node_modules/ghostty-opentui/public/jetbrains-mono-nerd.ttf")
title_font = ImageFont.truetype(font_path, 17)
badge_font = ImageFont.truetype(font_path, 16)


def backdrop():
    bg = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(bg)
    for y in range(H):
        k = y / (H - 1)
        d.line([(0, y), (W, y)], fill=tuple(round(a + (b - a) * k) for a, b in zip(BG_TOP, BG_BOTTOM)))
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([PAD, PAD + 10, W - PAD, H - PAD + 10], 14, fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))
    bg.paste(Image.new("RGB", (W, H), (0, 0, 0)), (0, 0), shadow)
    win = ImageDraw.Draw(bg)
    win.rounded_rectangle([PAD, PAD, W - PAD - 1, H - PAD - 1], 12, fill=(22, 22, 26), outline=(52, 52, 60))
    win.rectangle([PAD + 1, PAD + BAR - 1, W - PAD - 2, PAD + BAR], fill=(40, 40, 46))
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        cx, cy = PAD + 22 + i * 22, PAD + BAR // 2
        win.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=c)
    title = scene.get("title", "b4agent")
    tw = win.textlength(title, font=title_font)
    win.text(((W - tw) / 2, PAD + BAR / 2), title, font=title_font, fill=(150, 146, 138), anchor="lm")
    return bg


BACK = backdrop()
MASK = Image.new("L", (CONTENT_W, CONTENT_H), 0)
ImageDraw.Draw(MASK).rounded_rectangle([0, -20, CONTENT_W - 1, CONTENT_H - 1], 11, fill=255)


def rect_px(r):
    if r == "full":
        r = [0, 0, cols, rows]
    x, y, w, h = r[0] * CW, r[1] * CH, r[2] * CW, r[3] * CH
    # Grow to the window's aspect around the centre, then keep it on screen.
    if w / h < ASPECT:
        w2 = h * ASPECT
        x -= (w2 - w) / 2
        w = w2
    else:
        h2 = w / ASPECT
        y -= (h2 - h) / 2
        h = h2
    w, h = min(w, SW), min(h, SH)
    x = max(0, min(SW - w, x))
    y = max(0, min(SH - h, y))
    return (x, y, w, h)


def ease(k):
    return 4 * k ** 3 if k < 0.5 else 1 - (-2 * k + 2) ** 3 / 2


cam_keys = sorted(
    ({"t": at(k["at"]), "rect": rect_px(k["rect"]), "dur": k.get("dur", 750)} for k in scene.get("camera", []) if at(k["at"]) is not None),
    key=lambda k: k["t"],
) or [{"t": 0, "rect": rect_px("full"), "dur": 0}]


def _interp(k, t):
    p = 1 if k["dur"] <= 0 else min(1, max(0, (t - k["t"]) / k["dur"]))
    e = ease(p)
    return tuple(a + (b - a) * e for a, b in zip(k["from"], k["rect"]))


# Each move starts from where the camera is when it begins, even mid-move.
cam_keys[0]["from"] = cam_keys[0]["rect"]
for j in range(1, len(cam_keys)):
    cam_keys[j]["from"] = _interp(cam_keys[j - 1], cam_keys[j]["t"])


def camera(t):
    cur = cam_keys[0]
    for k in cam_keys:
        if k["t"] <= t:
            cur = k
    return _interp(cur, t)


# Output time -> source time, with fast-forward ranges.
fast = sorted(((at(a), at(b), s) for a, b, s in scene.get("fast", []) if at(a) is not None and at(b) is not None), key=lambda f: f[0])
# Hold windows (dialogs the recorder answered) play at normal speed: cut them out of fast ranges.
holds = sorted((m["t"], n["t"]) for m, n in zip(tl["marks"], tl["marks"][1:]) if m["name"].startswith("hold") and m["name"].endswith("a") and n["name"].startswith("hold") and n["name"].endswith("b"))
for ha, hb in holds:
    cut = []
    for a, b, sp in fast:
        if hb <= a or ha >= b:
            cut.append((a, b, sp))
            continue
        if ha > a:
            cut.append((a, ha, sp))
        if hb < b:
            cut.append((hb, b, sp))
    fast = cut
start = at(scene.get("start", 0))
# Ends shortly after the screen last changed; the hold then shows the final frame.
end = min(tl["end"], frames[-1]["t"] + 600) if "end" not in scene else at(scene["end"])


def segments():
    t, segs = start, []
    for a, b, s in fast:
        a, b = max(a, start), min(b, end)
        if b <= t:
            continue
        if a > t:
            segs.append((t, a, 1))
        segs.append((max(a, t), b, s))
        t = b
    if t < end:
        segs.append((t, end, 1))
    return segs


SEGS = segments()
OUT_LEN = sum((b - a) / s for a, b, s in SEGS)


def source_time(o):
    for a, b, s in SEGS:
        d = (b - a) / s
        if o <= d:
            return a + o * s, s
        o -= d
    return end, 1


times = [f["t"] for f in frames]


def frame_at(t):
    lo, hi = 0, len(times) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if times[mid] <= t:
            lo = mid
        else:
            hi = mid - 1
    return lo


@lru_cache(maxsize=24)
def source(i):
    return Image.open(rec / frames[i]["file"]).convert("RGB")


KEYS = [(m["t"], m["name"][4:]) for m in tl["marks"] if m["name"].startswith("key:")]
KEY_SHOW = 1300  # ms of output time a keystroke badge stays up
key_font = ImageFont.truetype(font_path, 22)


def key_at(t, speed):
    """The keystroke badge to show at source time t, if any."""
    for kt, label in reversed(KEYS):
        if 0 <= t - kt <= KEY_SHOW * speed:
            return label.replace("+", " + ")
    return None


def render(i, cam, speed, key=None):
    x, y, w, h = cam
    view = source(i).resize((CONTENT_W, CONTENT_H), Image.LANCZOS, box=(x, y, x + w, y + h))
    img = BACK.copy()
    img.paste(view, (PAD, PAD + BAR), MASK)
    if speed > 1:
        d = ImageDraw.Draw(img)
        label = f"▶▶ {speed:g}×"
        tw = d.textlength(label, font=badge_font)
        bx, by = W - PAD - 18 - tw, PAD + BAR / 2
        d.rounded_rectangle([bx - 10, by - 13, bx + tw + 10, by + 13], 8, fill=(56, 50, 34))
        d.text((bx, by), label, font=badge_font, fill=(216, 171, 82), anchor="lm")
    if key:
        d = ImageDraw.Draw(img)
        tw = d.textlength(key, font=key_font)
        cx, cy = W / 2, PAD + BAR + CONTENT_H - 70
        d.rounded_rectangle([cx - tw / 2 - 18, cy - 22, cx + tw / 2 + 18, cy + 22], 12, fill=(44, 44, 54), outline=(110, 104, 140), width=2)
        d.text((cx, cy), key, font=key_font, fill=(236, 232, 245), anchor="mm")
    return img


out_frames, durations = [], []
last_key = None
step = 1000 / FPS
o = 0.0
while o <= OUT_LEN:
    t, s = source_time(o)
    cam = tuple(round(v, 1) for v in camera(t))
    i = frame_at(t)
    badge = key_at(t, s)
    key = (i, cam, s, badge)
    if key == last_key:
        durations[-1] += step
    else:
        out_frames.append(render(i, cam, s, badge))
        durations.append(step)
        last_key = key
    o += step
durations[-1] += scene.get("hold", 2500)

out.parent.mkdir(parents=True, exist_ok=True)
out_frames[0].save(
    out, save_all=True, append_images=out_frames[1:], duration=[round(d) for d in durations],
    loop=0, quality=scene.get("quality", 82), method=scene.get("method", 4),
    minimize_size=True, allow_mixed=scene.get("mixed", False),
)
if len(sys.argv) > 4:
    out_frames[-1].save(sys.argv[4])
print(f"{out}: {len(out_frames)} frames, {OUT_LEN / 1000 + scene.get('hold', 2500) / 1000:.1f}s, {out.stat().st_size / 1e6:.2f} MB, {W}x{H}")
