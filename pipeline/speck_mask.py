"""List the small cells holding specks: lone points just off a surface, too close to it for air_mask.py.

Points of the coarse levels sit about 6 cm apart on a surface, so that a cell of FINE_VOXEL has several
occupied cells around it, whereas a speck has next to none. The work goes tile by tile to fit in memory.

The scanner also records a small ball of false echoes around itself, right where it stands: the cells around
each scanner position are listed too. No real surface can be that close, the scanner measures from further away.
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

from coarse_points import load_manifest, zone_points

FINE_VOXEL = 0.125
WINDOW = 5
MAX_NEIGHBOURS = 3
TILE = 256
MIN_TONE = 8
SCANNER_BALL = 0.3


def speck_cells(points):
    low = np.floor(points.min(axis=0) / FINE_VOXEL) * FINE_VOXEL
    cell = ((points - low) / FINE_VOXEL).astype(np.int32)
    shape = cell.max(axis=0) + 1
    margin = WINDOW // 2 + 1
    tiles = cell // TILE
    order = np.lexsort(tiles.T)
    cell, tiles = cell[order], tiles[order]
    changes = np.flatnonzero(np.any(np.diff(tiles, axis=0), axis=1)) + 1
    numbers = []
    # Each tile sees its own points and those of the margin around it, to judge the cells near its edges.
    grid_low = {}
    for begin, end in zip(np.r_[0, changes], np.r_[changes, len(cell)]):
        grid_low[tuple(tiles[begin])] = (begin, end)
    for tile, (begin, end) in grid_low.items():
        corner = np.array(tile) * TILE - margin
        parts = []
        for other in np.ndindex(3, 3, 3):
            key = tuple(np.array(tile) + other - 1)
            if key in grid_low:
                b, e = grid_low[key]
                local = cell[b:e] - corner
                parts.append(local[np.all((local >= 0) & (local < TILE + 2 * margin), axis=1)])
        local = np.concatenate(parts)
        occupied = np.zeros((TILE + 2 * margin,) * 3, bool)
        occupied[tuple(local.T)] = True
        crowd = ndimage.uniform_filter(occupied.astype(np.float32), WINDOW, mode="constant") * WINDOW**3
        lonely = occupied & (crowd < MAX_NEIGHBOURS + 1.5)
        inner = np.zeros_like(lonely)
        inner[margin:margin + TILE, margin:margin + TILE, margin:margin + TILE] = True
        found = np.argwhere(lonely & inner) + corner
        numbers.append(found[:, 0].astype(np.int64) + found[:, 1] * shape[0] + found[:, 2].astype(np.int64) * shape[0] * shape[1])
    return np.sort(np.concatenate(numbers)), low, shape


def scanner_balls(stations, low, shape):
    reach = int(np.ceil(SCANNER_BALL / FINE_VOXEL))
    offsets = np.array(list(np.ndindex(2 * reach + 1, 2 * reach + 1, 2 * reach + 1))) - reach
    numbers = []
    for station in stations:
        center = ((station - low) / FINE_VOXEL).astype(np.int64)
        cells = center + offsets
        middle = low + (cells + 0.5) * FINE_VOXEL
        cells = cells[np.linalg.norm(middle - station, axis=1) <= SCANNER_BALL]
        numbers.append(cells[:, 0] + cells[:, 1] * shape[0] + cells[:, 2] * shape[0] * shape[1])
    return np.concatenate(numbers)


def write_mask(numbers, low, shape, path):
    header = json.dumps({"voxel": FINE_VOXEL, "low": low.tolist(), "shape": shape.tolist()}).encode()
    with open(path, "wb") as out:
        np.array([len(header)], "<u4").tofile(out)
        out.write(header.ljust((len(header) + 3) // 4 * 4))
        numbers.astype("<u4").tofile(out)


if __name__ == "__main__":
    cache, output = sys.argv[1], Path(sys.argv[2])
    zones = load_manifest()
    points = np.concatenate([p[t >= MIN_TONE] for p, t in (zone_points(z, cache) for z in zones)])
    numbers, low, shape = speck_cells(points)
    stations = np.array([s["position"] for z in zones for s in z["stations"]], float)
    numbers = np.unique(np.concatenate([numbers, scanner_balls(stations, low, shape)]))
    write_mask(numbers, low, shape, output)
    print("points", len(points), "cellules isolées", len(numbers), "taille", output.stat().st_size / 1e3, "ko", "grille", shape, int(np.prod(shape.astype(np.int64))) < 2**32)
