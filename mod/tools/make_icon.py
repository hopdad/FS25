"""Generates FS25_FarmLink/icon_farmLink.png (256x256): a field-green tile with ledger rows and a
sprout. Standard library only, so it runs anywhere Python 3 does."""

import struct
import zlib
from pathlib import Path

SIZE = 256
BG = (31, 77, 43, 255)
ROW = (232, 226, 205, 255)
ROW_DIM = (120, 150, 118, 255)
SPROUT = (174, 214, 94, 255)
SOIL = (122, 84, 52, 255)


def blank():
    return [[BG for _ in range(SIZE)] for _ in range(SIZE)]


def rect(px, x0, y0, x1, y1, color):
    for y in range(max(0, y0), min(SIZE, y1)):
        for x in range(max(0, x0), min(SIZE, x1)):
            px[y][x] = color


def disc(px, cx, cy, r, color):
    for y in range(cy - r, cy + r + 1):
        for x in range(cx - r, cx + r + 1):
            if 0 <= x < SIZE and 0 <= y < SIZE and (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                px[y][x] = color


def leaf(px, cx, cy, rx, ry, color):
    for y in range(cy - ry, cy + ry + 1):
        for x in range(cx - rx, cx + rx + 1):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1:
                px[y][x] = color


def draw():
    px = blank()
    # ledger rows
    for i, y in enumerate(range(150, 230, 20)):
        rect(px, 40, y, 216, y + 8, ROW if i % 2 == 0 else ROW_DIM)
    # soil mound and sprout above the ledger
    leaf(px, 128, 138, 44, 10, SOIL)
    rect(px, 124, 70, 132, 132, SPROUT)
    leaf(px, 100, 84, 26, 12, SPROUT)
    leaf(px, 156, 64, 26, 12, SPROUT)
    disc(px, 128, 66, 6, SPROUT)
    return px


def png(px):
    raw = b"".join(b"\x00" + b"".join(struct.pack("BBBB", *p) for p in row) for row in px)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "FS25_FarmLink" / "icon_farmLink.png"
    out.write_bytes(png(draw()))
    print(f"wrote {out}")
