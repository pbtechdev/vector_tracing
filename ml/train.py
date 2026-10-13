"""Trains the 4x ink sharpener on synthetic data and exports it to ONNX for the browser.

    .venv-ml/bin/python ml/train.py --steps 30000

Outputs:
  ml/runs/sharpener.pt                     PyTorch weights
  public/models/ink-sharpener-x4.onnx      model loaded by the app (runs locally in the browser)
  ml/runs/eval.png                         held-out font examples: input | baseline | model | target
"""

from __future__ import annotations

import argparse
import math
import os
import time

import numpy as np
import torch
from PIL import Image
from torch.nn import functional as F
from torch.utils.data import DataLoader, IterableDataset

from model import SCALE, Sharpener
from synth import discover_fonts, load_words, make_sample

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Synthetic(IterableDataset):
    def __init__(self, fonts, words, size: int, base_seed: int):
        self.fonts, self.words, self.size, self.base_seed = fonts, words, size, base_seed

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        wid = info.id if info else 0
        seed = self.base_seed + wid * 10_000_000
        while True:
            x, y = make_sample(seed, self.fonts, self.words, self.size)
            seed += 1
            yield torch.from_numpy(x)[None], torch.from_numpy(y)[None]


def loss_fn(logits, target):
    bce = F.binary_cross_entropy_with_logits(logits, target)
    p = torch.sigmoid(logits)
    inter = (p * target).sum((1, 2, 3))
    dice = 1 - (2 * inter + 1) / (p.sum((1, 2, 3)) + target.sum((1, 2, 3)) + 1)
    return bce + 0.3 * dice.mean()


def baseline(x):
    """What the app did before: smooth upscaling followed by an Otsu-like 0.5 threshold."""
    up = F.interpolate(x, scale_factor=SCALE, mode="bicubic", align_corners=False)
    lo = up.amin((2, 3), keepdim=True)
    hi = up.amax((2, 3), keepdim=True)
    return ((hi - up) / (hi - lo + 1e-6) > 0.5).float()


def iou(pred, target):
    t = (target > 0.5).float()
    inter = (pred * t).sum()
    union = ((pred + t) > 0).float().sum()
    return (inter / union.clamp(min=1)).item()


@torch.no_grad()
def evaluate(model, samples, device):
    model.eval()
    xs = torch.stack([torch.from_numpy(x)[None] for x, _ in samples]).to(device)
    ys = torch.stack([torch.from_numpy(y)[None] for _, y in samples]).to(device)
    pred = (torch.sigmoid(model(xs)) > 0.5).float()
    model.train()
    return iou(pred, ys), iou(baseline(xs), ys), pred


def export_onnx(model, path):
    model = model.cpu().eval()
    dummy = torch.rand(1, 1, 64, 80)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    torch.onnx.export(
        model,
        dummy,
        path,
        input_names=["image"],
        output_names=["ink"],
        dynamic_axes={"image": {2: "h", 3: "w"}, "ink": {2: "H", 3: "W"}},
        opset_version=17,
        dynamo=False,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--size", type=int, default=64)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--workers", type=int, default=10)
    args = ap.parse_args()

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    train_fonts, held_fonts = discover_fonts()
    words = load_words()
    print(f"device {device}; fonts {len(train_fonts)} train / {len(held_fonts)} held-out", flush=True)

    held = [make_sample(9_000_000 + i, held_fonts, words, 96) for i in range(256)]
    loader = DataLoader(Synthetic(train_fonts, words, args.size, 1), batch_size=args.batch, num_workers=args.workers, persistent_workers=True, prefetch_factor=4)

    model = Sharpener().to(device)
    print(f"parameters: {sum(p.numel() for p in model.parameters()):,}", flush=True)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-5)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, s / 500) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / args.steps))))

    m_iou, b_iou, _ = evaluate(model, held, device)
    print(f"step 0  held-out IoU model {m_iou:.4f}  baseline {b_iou:.4f}", flush=True)
    t0 = time.time()
    running = 0.0
    for step, (x, y) in enumerate(loader, start=1):
        x, y = x.to(device, non_blocking=True), y.to(device, non_blocking=True)
        loss = loss_fn(model(x), y)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        running += loss.item()
        if step % 500 == 0:
            m_iou, b_iou, _ = evaluate(model, held, device)
            print(f"step {step}  loss {running / 500:.4f}  held-out IoU model {m_iou:.4f}  baseline {b_iou:.4f}  {time.time() - t0:.0f}s", flush=True)
            running = 0.0
        if step % 5000 == 0 or step == args.steps:
            torch.save(model.state_dict(), os.path.join(ROOT, "ml/runs/sharpener.pt"))
        if step >= args.steps:
            break

    m_iou, b_iou, pred = evaluate(model, held, device)
    print(f"final held-out IoU model {m_iou:.4f}  baseline {b_iou:.4f}", flush=True)
    rows = []
    xs = torch.stack([torch.from_numpy(x)[None] for x, _ in held[:10]])
    base = baseline(xs.to(device)).cpu()
    for i in range(10):
        x, y = held[i]
        up = np.asarray(Image.fromarray((x * 255).astype(np.uint8)).resize(y.shape[::-1], Image.NEAREST), dtype=np.float32) / 255
        rows.append(np.concatenate([up, 1 - base[i, 0].numpy(), 1 - pred[i, 0].cpu().numpy(), 1 - y], axis=1))
    Image.fromarray((np.concatenate(rows, 0) * 255).astype(np.uint8)).save(os.path.join(ROOT, "ml/runs/eval.png"))
    export_onnx(model, os.path.join(ROOT, "public/models/ink-sharpener-x4.onnx"))
    print("exported public/models/ink-sharpener-x4.onnx", flush=True)


if __name__ == "__main__":
    main()
