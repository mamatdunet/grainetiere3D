"""List the cells of space that only hold what floats in the air: birds, laser noise, echoes on edges.

The whole abbey is cut into cells. Cells well filled with points form solid pieces; only pieces of some
size count as real, with the sparse cells directly around them (twigs, edges). A sparse cell further away
still counts as real when many occupied cells surround it, as in foliage. What lies close to the ground stays,
and small pieces left high above it go, gaps of one cell apart. Anything else is listed in air-mask.bin and
dropped by the viewer at every level of detail, so that a bird disappears entirely.
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

from coarse_points import load_manifest, zone_points

VOXEL = 0.4
MIN_TONE = 8
SOLID_POINTS = 6
MIN_PIECE = 12
MARGIN_CELLS = 1
CROWD_WIDTH = 7
CROWD_CELLS = 10
GROUND_WINDOW = 11
GROUND_MARGIN = 0.8
SMALL_PIECE = 60


def build_mask(zones, cache):
    parts = []
    for zone in zones:
        points, tones = zone_points(zone, cache)
        parts.append(points[tones >= MIN_TONE])
    points = np.concatenate(parts)
    low = np.floor(points.min(axis=0) / VOXEL) * VOXEL
    cell = ((points - low) / VOXEL).astype(np.int32)
    shape = cell.max(axis=0) + 1
    code = cell[:, 0] + cell[:, 1] * shape[0] + cell[:, 2] * shape[0] * shape[1]
    counts = np.bincount(code, minlength=int(np.prod(shape))).reshape(shape[::-1]).transpose(2, 1, 0)
    occupied = counts > 0
    pieces, _ = ndimage.label(counts >= SOLID_POINTS, structure=np.ones((3, 3, 3)))
    sizes = np.bincount(pieces.ravel())
    sizes[0] = 0
    real = sizes[pieces] >= MIN_PIECE
    near = ndimage.binary_dilation(real, structure=np.ones((3, 3, 3)), iterations=MARGIN_CELLS)
    crowd = ndimage.uniform_filter(occupied.astype(np.float32), CROWD_WIDTH, mode="constant") * CROWD_WIDTH**3
    air = occupied & ~near & (crowd < CROWD_CELLS - 0.5)

    # Ground height: the lowest real cell of each column, or of the columns around where it has none.
    floor = np.where(real.any(axis=2), real.argmax(axis=2), shape[2]).astype(np.float32)
    floor = ndimage.minimum_filter(floor, GROUND_WINDOW)
    height = (np.arange(shape[2])[None, None, :] - floor[:, :, None]) * VOXEL
    air &= (height > GROUND_MARGIN) | (height < -GROUND_MARGIN)

    kept = occupied & ~air
    groups, _ = ndimage.label(ndimage.binary_dilation(kept, structure=np.ones((3, 3, 3))), structure=np.ones((3, 3, 3)))
    group_sizes = np.bincount(groups[kept], minlength=groups.max() + 1)
    air |= kept & (group_sizes[groups] < SMALL_PIECE) & (height > GROUND_MARGIN)
    return {"low": low, "shape": shape, "air": air, "real": real, "counts": counts, "occupied": occupied, "sizes": sizes}


def write_mask(result, path):
    """Sorted cell numbers, with the grid they refer to in the header."""
    x, y, z = np.nonzero(result["air"])
    shape = result["shape"]
    numbers = np.sort((x + y * shape[0] + z * shape[0] * shape[1]).astype(np.uint32))
    header = json.dumps({"voxel": VOXEL, "low": result["low"].tolist(), "shape": shape.tolist()}).encode()
    with open(path, "wb") as out:
        np.array([len(header)], "<u4").tofile(out)
        out.write(header.ljust((len(header) + 3) // 4 * 4))
        numbers.astype("<u4").tofile(out)


if __name__ == "__main__":
    cache, output = sys.argv[1], Path(sys.argv[2])
    result = build_mask(load_manifest(), cache)
    write_mask(result, output)
    air, counts = result["air"], result["counts"]
    print("cellules", int(result["occupied"].sum()), "air", int(air.sum()))
    print("points niveaux grossiers", int(counts.sum()), "dans l'air", int(counts[air].sum()))
    print("taille", output.stat().st_size / 1e3, "ko")
    if len(sys.argv) > 3:
        from PIL import Image
        real, gray = result["occupied"] & ~air, None
        for name, axis in (("side_x", 1), ("side_y", 0), ("top", 2)):
            kept = real.sum(axis=axis)
            gone = air.sum(axis=axis)
            image = np.zeros((*kept.shape, 3), np.uint8)
            image[..., :] = np.clip(np.log1p(kept) * 60, 0, 255)[..., None].astype(np.uint8)
            image[gone > 0] = (255, 40, 40)
            Image.fromarray(np.flipud(image.transpose(1, 0, 2))).save(f"{sys.argv[3]}_{name}.png")
