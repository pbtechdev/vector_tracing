"""4x ink sharpener: low-res grayscale (1 = paper) -> high-res ink logits.

A compact residual CNN with a pixel-shuffle head. A bilinear "threshold" path is added to the
output so the untrained network already behaves like plain upscaling + thresholding; the
convolutions learn the correction (sharper corners, restored stroke shapes, removed blur/JPEG).
"""

import torch
from torch import nn
from torch.nn import functional as F

SCALE = 4


class Block(nn.Module):
    def __init__(self, ch: int):
        super().__init__()
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1)
        self.c2 = nn.Conv2d(ch, ch, 3, padding=1)

    def forward(self, x):
        return x + self.c2(F.relu(self.c1(x)))


class Sharpener(nn.Module):
    def __init__(self, ch: int = 32, blocks: int = 5):
        super().__init__()
        self.head = nn.Conv2d(1, ch, 3, padding=1)
        self.body = nn.Sequential(*[Block(ch) for _ in range(blocks)])
        self.mid = nn.Conv2d(ch, ch, 3, padding=1)
        self.up = nn.Conv2d(ch, SCALE * SCALE, 3, padding=1)
        self.shuffle = nn.PixelShuffle(SCALE)
        self.gain = nn.Parameter(torch.tensor(8.0))

    def forward(self, x):
        f = F.relu(self.head(x - 0.5))
        f = F.relu(self.mid(self.body(f))) + f
        residual = self.shuffle(self.up(f))
        base = (0.5 - F.interpolate(x, scale_factor=SCALE, mode="bilinear", align_corners=False)) * self.gain
        return base + residual
