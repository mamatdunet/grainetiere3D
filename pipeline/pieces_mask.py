"""List what the cleaning tool can take with one click, and the building it must leave alone.

people_mask.py sets floors, vaults and walls apart, then keeps only the pieces that look like a person. Here all
the pieces are kept, numbered on the grid of people-mask.bin so that what the administrator cleans by hand fits
with it. A click takes the part of a piece within reach of the pointer, so that a piece running into furniture
need not go whole. Each piece says whether it touches the building, and whether it has nothing at all around it:
those loose fragments can go all at once.

Rough stone weaves from one column of cells to the next, so walls are also looked for on a grid widened by one
cell sideways. Only large stretches found that way count: furniture in a room also makes tall runs on such a grid.
The cells of the people mask are never taken for walls that way. A short run of wall hanging in the
air, clear of any floor or vault, is an echo rather than masonry: it is a piece.
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

from coarse_points import load_manifest
from people_mask import FULL, VOXEL, load_points, structure, tall_runs

LOOSE_REACH = 1
ECHO_CELLS = 2000
ROUGH_CELLS = 300
LOOSE, TOUCHING = 1, 2


def analyse(points, people):
    low = np.floor(points.min(axis=0) / VOXEL) * VOXEL
    cell = ((points - low) / VOXEL).astype(np.int32)
    occupied = np.zeros(cell.max(axis=0) + 1, bool)
    occupied[cell[:, 0], cell[:, 1], cell[:, 2]] = True
    planes, walls = structure(occupied)
    rough = tall_runs(ndimage.binary_dilation(occupied, structure=np.ones((3, 3, 1), bool))) & occupied & ~walls
    rough[people(low, occupied.shape)] = False
    stretches, count = ndimage.label(rough, structure=FULL)
    large = np.bincount(stretches.ravel(), minlength=count + 1) >= ROUGH_CELLS
    large[0] = False
    walls |= large[stretches]
    runs, count = ndimage.label(walls, structure=FULL)
    echo = np.bincount(runs.ravel(), minlength=count + 1) < ECHO_CELLS
    echo[runs[ndimage.binary_dilation(planes, structure=FULL, iterations=2) & (runs > 0)]] = False
    echo[0] = False
    walls &= ~echo[runs]
    solid = ndimage.binary_dilation(planes, structure=np.ones((1, 1, 3), bool)) | walls
    pieces, count = ndimage.label(occupied & ~solid, structure=FULL)
    sizes = np.bincount(pieces.ravel(), minlength=count + 1)
    sizes[0] = 0
    # Loose: alone even when small gaps are bridged, among all that is occupied.
    groups, _ = ndimage.label(ndimage.binary_dilation(occupied, structure=FULL, iterations=LOOSE_REACH), structure=FULL)
    group_sizes = np.bincount(groups[occupied], minlength=groups.max() + 1)
    group_of = np.zeros(count + 1, np.int64)
    group_of[pieces[pieces > 0]] = groups[pieces > 0]
    loose = group_sizes[group_of] == sizes
    loose[0] = False
    touching = np.zeros(count + 1, bool)
    near_solid = ndimage.binary_dilation(solid & occupied, structure=FULL) & (pieces > 0)
    touching[pieces[near_solid]] = True
    flags = loose * LOOSE + touching * TOUCHING
    return low, pieces, flags, solid


def write_pieces(low, pieces, flags, solid, header, path):
    """All in one gzip stream: the header, then cells as gaps with the piece of each, flags, solid cells as gaps."""
    offset = np.round((low - np.array(header["low"])) / VOXEL).astype(np.int64)
    width, depth = header["shape"][:2]

    def numbers(mask):
        x, y, z = np.nonzero(mask)
        return (x + offset[0]) + (y + offset[1]) * width + (z + offset[2]) * width * depth, (x, y, z)

    cells, at = numbers(pieces > 0)
    order = np.argsort(cells)
    cells = cells[order]
    owner = pieces[at][order] - 1
    solid_cells = np.sort(numbers(solid)[0])
    text = json.dumps({"voxel": VOXEL, "low": header["low"], "shape": header["shape"], "pieces": int(flags.size - 1), "cells": len(cells), "solid": len(solid_cells)}).encode()
    with gzip.open(path, "wb", compresslevel=9) as out:
        out.write(np.array([len(text)], "<u4").tobytes())
        out.write(text.ljust((len(text) + 3) // 4 * 4))
        out.write(np.diff(cells, prepend=0).astype("<u4").tobytes())
        out.write(owner.astype("<u4").tobytes())
        written = flags[1:].astype("u1").tobytes()
        out.write(written.ljust((len(written) + 3) // 4 * 4, b"\0"))
        out.write(np.diff(solid_cells, prepend=0).astype("<u4").tobytes())
    return len(cells)


def read_header(path):
    with open(path, "rb") as source:
        size = int(np.frombuffer(source.read(4), "<u4")[0])
        return json.loads(source.read(size))


def people_cells(path):
    """The cells of people-mask.bin, as indexes into a grid starting at low."""
    header = read_header(path)
    data = Path(path).read_bytes()
    size = int(np.frombuffer(data[:4], "<u4")[0])
    numbers = np.frombuffer(data, "<u4", offset=4 + (size + 3) // 4 * 4).astype(np.int64)
    width, depth = header["shape"][:2]

    def inside(low, shape):
        offset = np.round((low - np.array(header["low"])) / VOXEL).astype(np.int64)
        at = np.stack([numbers % width, numbers // width % depth, numbers // (width * depth)]) - offset[:, None]
        at = at[:, np.all((at >= 0) & (at < np.array(shape)[:, None]), axis=0)]
        return tuple(at)
    return inside


if __name__ == "__main__":
    cache, people_path, output, mask_paths = sys.argv[1], sys.argv[2], Path(sys.argv[3]), sys.argv[4:]
    _, points = load_points(load_manifest(), cache, mask_paths)
    low, pieces, flags, solid = analyse(points, people_cells(people_path))
    count = write_pieces(low, pieces, flags, solid, read_header(people_path), output)
    print("morceaux", flags.size - 1, "isolés", int((flags & LOOSE).astype(bool).sum()), "cases", count, "bâti", int(solid.sum()), "taille", output.stat().st_size / 1e6, "Mo")
