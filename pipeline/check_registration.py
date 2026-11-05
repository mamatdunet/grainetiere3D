#!/usr/bin/env python3
"""Check that scans line up: distance between each scan and its closest neighbours."""
import sys

import numpy as np
import pye57
from scipy.spatial import cKDTree

SAMPLE = 400_000

clouds, names = [], []
rng = np.random.default_rng(0)
for path in sorted(sys.argv[1:]):
    e57 = pye57.E57(path)
    header = e57.get_header(0)
    raw = e57.read_scan_raw(0)
    xyz = np.column_stack([raw["cartesianX"], raw["cartesianY"], raw["cartesianZ"]])
    # Keep the dense close-range part: far points are too sparse to measure gaps.
    near = xyz[np.linalg.norm(xyz, axis=1) < 12]
    near = near[rng.choice(len(near), min(SAMPLE, len(near)), replace=False)]
    world = near @ np.asarray(header.rotation_matrix).T + np.asarray(header.translation)
    clouds.append(world)
    names.append(path.split("/")[-1].removesuffix(".e57")[-4:])
    print(names[-1], "pos", np.round(header.translation, 2), "colour", "colorRed" in raw, "points", header.point_count)

origin = clouds[0].mean(axis=0)
trees = [cKDTree(c - origin) for c in clouds]
print("\nmedian gap in mm between overlapping surfaces (share of points within 5 cm)")
for i, a in enumerate(clouds):
    row = []
    for j, tree in enumerate(trees):
        if i == j:
            continue
        d, _ = tree.query(a[::10] - origin, distance_upper_bound=0.05)
        hit = d[np.isfinite(d)]
        if len(hit) > 0.05 * len(d):
            row.append(f"{names[j]}:{np.median(hit) * 1000:.1f}mm({len(hit) / len(d):.0%})")
    print(names[i], " ".join(row) or "no overlap")
