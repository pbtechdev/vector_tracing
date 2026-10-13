"""Synthetic training pairs for the 4x ink sharpener.

Every sample starts as crisp vector-like artwork rendered at high resolution (the target):
text in a random system font, or line art (zigzags, gear teeth, polygons, circles, strokes).
The input is the same artwork degraded the way real uploads are: optical blur, 4x area
downsampling, extra blur or a lossy down/up cycle, tone changes, noise and JPEG compression.
"""

from __future__ import annotations

import glob
import hashlib
import io
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SCALE = 4
FONT_DIRS = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", os.path.expanduser("~/Library/Fonts")]
SKIP = ("emoji", "braille", "lastresort", "symbol", "dingbat", "keyboard", "webdings", "wingdings", "ornaments", "sfcamera", "nastaliq")
WORDS_FILE = "/usr/share/dict/words"


def _latin_faces(path: str) -> list[int]:
    faces = []
    for index in range(8):
        try:
            font = ImageFont.truetype(path, 48, index=index)
        except (OSError, ValueError):
            break
        try:
            probe = font.getmask("Rag4").getbbox()
            tofu = font.getmask("\u0378\u0379\u037f\u0380").getbbox()
            if probe and probe != tofu and font.getbbox("Rag4")[2] > 40:
                faces.append(index)
        except Exception:  # noqa: BLE001 - broken fonts are simply skipped
            pass
    return faces


def discover_fonts() -> tuple[list[tuple[str, int]], list[tuple[str, int]]]:
    """All Latin-capable font faces, split into training and held-out (unseen) fonts."""
    train, held = [], []
    for d in FONT_DIRS:
        for path in sorted(glob.glob(os.path.join(d, "*.tt[fc]")) + glob.glob(os.path.join(d, "*.otf"))):
            if any(s in os.path.basename(path).lower() for s in SKIP):
                continue
            for index in _latin_faces(path):
                key = f"{os.path.basename(path)}#{index}"
                bucket = int(hashlib.md5(key.encode()).hexdigest(), 16) % 100
                (held if bucket < 12 else train).append((path, index))
    return train, held


def load_words() -> list[str]:
    try:
        with open(WORDS_FILE, encoding="utf-8") as f:
            return [w.strip() for w in f if 2 <= len(w.strip()) <= 12]
    except OSError:
        return ["vector", "trace", "Gear", "Bracket", "CorelDRAW", "Sample", "Text", "Logo", "2026", "A-12"]


def random_text(rng: random.Random, words: list[str]) -> str:
    kind = rng.random()
    if kind < 0.55:
        text = " ".join(rng.choice(words) for _ in range(rng.randint(1, 4)))
    elif kind < 0.75:
        text = "".join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ0123456789-./") for _ in range(rng.randint(3, 10)))
    else:
        pool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&@#%?!()[]{}:;,.'\"/+-=*$"
        text = "".join(rng.choice(pool) for _ in range(rng.randint(3, 14)))
    r = rng.random()
    if r < 0.2:
        text = text.upper()
    elif r < 0.3:
        text = text.capitalize()
    return text


def draw_text(img: Image.Image, rng: random.Random, fonts: list[tuple[str, int]], words: list[str]) -> None:
    w, h = img.size
    draw = ImageDraw.Draw(img)
    lines = rng.randint(1, 4)
    y = rng.uniform(-0.2, 0.3) * h
    for _ in range(lines):
        path, index = rng.choice(fonts)
        # Cap height in input pixels from ~3 (barely legible) to ~40.
        size = int(rng.choice([rng.uniform(3, 9), rng.uniform(6, 18), rng.uniform(12, 45)]) * SCALE * 1.4)
        try:
            font = ImageFont.truetype(path, max(8, size), index=index)
        except OSError:
            continue
        text = random_text(rng, words)
        x = rng.uniform(-0.3, 0.2) * w
        stroke = rng.choice([0, 0, 0, 0, max(1, size // 40)])
        draw.text((x, y), text, font=font, fill=255, stroke_width=stroke, stroke_fill=255)
        y += size * rng.uniform(0.9, 1.5)
        if y > h:
            break


def _gear(cx, cy, teeth, r0, r1, base, tip, phase):
    pts = []
    for k in range(teeth):
        c = phase + 2 * math.pi * k / teeth
        p = 2 * math.pi / teeth
        for r, a in ((r0, c - base * p), (r1, c - tip * p), (r1, c + tip * p), (r0, c + base * p)):
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def draw_shapes(img: Image.Image, rng: random.Random) -> None:
    w, h = img.size
    draw = ImageDraw.Draw(img)
    for _ in range(rng.randint(1, 4)):
        kind = rng.random()
        width = max(1, int(rng.choice([rng.uniform(1, 3), rng.uniform(2, 8)]) * SCALE))
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        if kind < 0.3:
            # Zigzag / serration / square wave along a line.
            period = rng.uniform(4, 24) * SCALE
            amp = rng.uniform(0.25, 1.0) * period
            ang = rng.uniform(0, math.pi)
            style = rng.choice(["zig", "zig", "trap", "square"])
            pts = []
            n = int(w * 1.5 / period) + 2
            start = -w * 0.25
            for i in range(n):
                t0 = start + i * period
                if style == "zig":
                    seq = [(t0, 0), (t0 + period / 2, amp)]
                elif style == "trap":
                    seq = [(t0, 0), (t0 + period * 0.2, 0), (t0 + period * 0.35, amp), (t0 + period * 0.65, amp), (t0 + period * 0.8, 0)]
                else:
                    seq = [(t0, 0), (t0, amp), (t0 + period / 2, amp), (t0 + period / 2, 0)]
                for u, v in seq:
                    pts.append((cx + u * math.cos(ang) - v * math.sin(ang), cy + u * math.sin(ang) + v * math.cos(ang)))
            draw.line(pts, fill=255, width=width, joint="curve" if rng.random() < 0.3 else None)
        elif kind < 0.5:
            r1 = rng.uniform(15, 60) * SCALE
            teeth = rng.randint(8, 40)
            pts = _gear(cx, cy, teeth, r1 * rng.uniform(0.75, 0.92), r1, rng.uniform(0.25, 0.4), rng.uniform(0.08, 0.2), rng.uniform(0, 6.3))
            if rng.random() < 0.5:
                draw.polygon(pts, fill=255)
                hole = r1 * rng.uniform(0.15, 0.4)
                draw.ellipse((cx - hole, cy - hole, cx + hole, cy + hole), fill=0)
            else:
                draw.line(pts + pts[:1], fill=255, width=width)
        elif kind < 0.65:
            n = rng.randint(3, 8)
            r = rng.uniform(6, 50) * SCALE
            ph = rng.uniform(0, 6.3)
            pts = [(cx + r * math.cos(ph + 2 * math.pi * i / n), cy + r * math.sin(ph + 2 * math.pi * i / n)) for i in range(n)]
            if rng.random() < 0.5:
                draw.polygon(pts, fill=255)
            else:
                draw.line(pts + pts[:1], fill=255, width=width)
        elif kind < 0.8:
            rx, ry = rng.uniform(3, 50) * SCALE, rng.uniform(3, 50) * SCALE
            if rng.random() < 0.5:
                ry = rx
            box = (cx - rx, cy - ry, cx + rx, cy + ry)
            if rng.random() < 0.5:
                draw.ellipse(box, fill=255)
            else:
                draw.ellipse(box, outline=255, width=width)
        else:
            # Free-hand-like smooth stroke.
            pts = []
            a, b = rng.uniform(20, 80) * SCALE, rng.uniform(10, 60) * SCALE
            f1, f2, ph = rng.randint(1, 3), rng.randint(1, 4), rng.uniform(0, 6.3)
            for i in range(200):
                t = i / 199 * 2 * math.pi * rng.uniform(0.4, 1.0)
                pts.append((cx + a * math.sin(f1 * t), cy + b * math.sin(f2 * t + ph)))
            draw.line(pts, fill=255, width=width, joint="curve")


def degrade(cov: np.ndarray, rng: random.Random, nrng: np.random.Generator) -> np.ndarray:
    """High-res coverage (1 = ink) -> low-res grayscale input (1 = paper)."""
    img = Image.fromarray((cov * 255).astype(np.uint8))
    if rng.random() < 0.5:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.5, 3.0) * SCALE / 2))
    h, w = cov.shape
    low = img.resize((w // SCALE, h // SCALE), Image.BOX)
    r = rng.random()
    if r < 0.25:
        low = low.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.2)))
    elif r < 0.4:
        f = rng.uniform(1.4, 2.2)
        small = low.resize((max(4, int(low.width / f)), max(4, int(low.height / f))), Image.BILINEAR)
        low = small.resize(low.size, rng.choice([Image.BILINEAR, Image.BICUBIC]))
    ink = np.asarray(low, dtype=np.float32) / 255.0
    paper = rng.uniform(0.62, 1.0)
    dark = rng.uniform(0.0, max(0.0, paper - 0.35))
    gamma = math.exp(rng.uniform(-0.4, 0.4))
    x = paper - (paper - dark) * (ink**gamma)
    if rng.random() < 0.3:
        yy, xx = np.mgrid[0 : x.shape[0], 0 : x.shape[1]] / max(x.shape)
        x = x * (1 - rng.uniform(0, 0.12) * (xx * rng.uniform(-1, 1) + yy * rng.uniform(-1, 1)))
    if rng.random() < 0.6:
        x = x + nrng.normal(0, rng.uniform(0.005, 0.04), x.shape)
    x = np.clip(x, 0, 1)
    if rng.random() < 0.55:
        buf = io.BytesIO()
        Image.fromarray((x * 255).astype(np.uint8)).save(buf, "JPEG", quality=rng.randint(25, 95))
        x = np.asarray(Image.open(buf), dtype=np.float32) / 255.0
    return x.astype(np.float32)


def make_sample(seed: int, fonts, words, size: int = 64) -> tuple[np.ndarray, np.ndarray]:
    """Returns (input size x size in [0,1], 1 = paper; target 4size x 4size coverage in [0,1])."""
    rng = random.Random(seed)
    nrng = np.random.default_rng(seed)
    hi = size * SCALE
    img = Image.new("L", (hi, hi), 0)
    r = rng.random()
    if r < 0.7:
        draw_text(img, rng, fonts, words)
    elif r < 0.95:
        draw_shapes(img, rng)
    else:
        draw_text(img, rng, fonts, words)
        draw_shapes(img, rng)
    if rng.random() < 0.3:
        img = img.rotate(rng.uniform(-12, 12), resample=Image.BICUBIC)
    cov = np.asarray(img, dtype=np.float32) / 255.0
    return degrade(cov, rng, nrng), cov


if __name__ == "__main__":
    train, held = discover_fonts()
    print(f"fonts: {len(train)} training faces, {len(held)} held-out faces")
    words = load_words()
    os.makedirs("ml/runs/preview", exist_ok=True)
    tiles = []
    for s in range(12):
        x, y = make_sample(1000 + s, train, words)
        up = np.asarray(Image.fromarray((x * 255).astype(np.uint8)).resize(y.shape[::-1], Image.NEAREST), dtype=np.float32) / 255
        tiles.append(np.concatenate([up, 1 - y], axis=1))
    sheet = np.concatenate(tiles, axis=0)
    Image.fromarray((sheet * 255).astype(np.uint8)).save("ml/runs/preview/samples.png")
    print("wrote ml/runs/preview/samples.png")
