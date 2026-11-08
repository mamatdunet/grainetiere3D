"""List what the cleaning tool can take with one click, and the building it must leave alone.

people_mask.py sets floors, vaults and walls apart, then keeps only the pieces that look like a person. Here all
the pieces of a modest size are kept, numbered on the grid of people-mask.bin so that what the administrator cleans
by hand fits with it. Fragments with nothing at all around them, building included, are marked as loose: they can
go all at once. Larger pieces are vaults, roofs and the like: they are not listed, and only the brush reaches them.
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

from coarse_points import load_manifest
from people_mask import FULL, VOXEL, load_points, structure

MAX_CELLS = 3000
LOOSE_REACH = 1


def analyse(points):
    low = np.floor(points.min(axis=0) / VOXEL) * VOXEL
    cell = ((points - low) / VOXEL).astype(np.int32)
    occupied = np.zeros(cell.max(axis=0) + 1, bool)
    occupied[cell[:, 0], cell[:, 1], cell[:, 2]] = True
    planes, walls = structure(occupied)
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
    return low, pieces, sizes, loose, solid


def write_pieces(low, pieces, sizes, loose, solid, header, path):
    """All in one gzip stream: the header, then listed cells as gaps with the piece of each, loose flags, solid cells as gaps."""
    offset = np.round((low - np.array(header["low"])) / VOXEL).astype(np.int64)
    width, depth = header["shape"][:2]

    def numbers(mask):
        x, y, z = np.nonzero(mask)
        return (x + offset[0]) + (y + offset[1]) * width + (z + offset[2]) * width * depth, (x, y, z)

    kept = sizes <= MAX_CELLS
    kept[0] = False
    new_number = np.cumsum(kept) * kept
    cells, at = numbers(kept[pieces])
    order = np.argsort(cells)
    cells = cells[order]
    owner = new_number[pieces[at]][order] - 1
    solid_cells = np.sort(numbers(solid)[0])
    text = json.dumps({"voxel": VOXEL, "low": header["low"], "shape": header["shape"], "pieces": int(kept.sum()), "cells": len(cells), "solid": len(solid_cells)}).encode()
    with gzip.open(path, "wb", compresslevel=9) as out:
        out.write(np.array([len(text)], "<u4").tobytes())
        out.write(text.ljust((len(text) + 3) // 4 * 4))
        out.write(np.diff(cells, prepend=0).astype("<u4").tobytes())
        out.write(owner.astype("<u4").tobytes())
        flags = loose[kept].astype("u1").tobytes()
        out.write(flags.ljust((len(flags) + 3) // 4 * 4, b"\0"))
        out.write(np.diff(solid_cells, prepend=0).astype("<u4").tobytes())
    return len(cells)


def read_header(path):
    with open(path, "rb") as source:
        size = int(np.frombuffer(source.read(4), "<u4")[0])
        return json.loads(source.read(size))


if __name__ == "__main__":
    cache, people_path, output, mask_paths = sys.argv[1], sys.argv[2], Path(sys.argv[3]), sys.argv[4:]
    _, points = load_points(load_manifest(), cache, mask_paths)
    low, pieces, sizes, loose, solid = analyse(points)
    count = write_pieces(low, pieces, sizes, loose, solid, read_header(people_path), output)
    listed = (sizes > 0) & (sizes <= MAX_CELLS)
    print("morceaux", int(listed.sum()), "isolés", int((loose & listed).sum()), "cases", count, "bâti", int(solid.sum()), "taille", output.stat().st_size / 1e6, "Mo")
