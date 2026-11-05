#!/usr/bin/env python3
"""Convert registered E57 scans into a streamable point cloud octree.

Output:
  metadata.json.gz   bounds, stations, node table
  chunks/N.bin       gzipped nodes packed into files below --chunk-mb,
                     read by the viewer through HTTP range requests

Each node keeps at most one point per cell of a grid^3 grid; the remaining
points go down to its children, so parents are a coarse preview of them.
"""
import argparse
import gzip
import json
import os
from pathlib import Path

import numpy as np
import pye57


def load_scan(path):
    e57 = pye57.E57(str(path))
    header = e57.get_header(0)
    raw = e57.read_scan_raw(0)
    xyz = np.column_stack([raw["cartesianX"], raw["cartesianY"], raw["cartesianZ"]]).astype(np.float64)
    valid = np.ones(len(xyz), dtype=bool)
    if "cartesianInvalidState" in raw:
        valid = raw["cartesianInvalidState"] == 0
    rotation = np.asarray(header.rotation_matrix, dtype=np.float64)
    translation = np.asarray(header.translation, dtype=np.float64)
    world = xyz[valid] @ rotation.T + translation
    rgb = None
    if "colorRed" in raw:
        rgb = np.column_stack([raw["colorRed"], raw["colorGreen"], raw["colorBlue"]])[valid]
    intensity = raw["intensity"][valid] if "intensity" in raw else None
    return world, intensity, rgb, translation


def load_all(paths):
    worlds, intensities, colors, stations = [], [], [], []
    for path in paths:
        world, intensity, rgb, translation = load_scan(path)
        print(f"{path.name}: {len(world):,} points, colour={'yes' if rgb is not None else 'no'}", flush=True)
        worlds.append(world)
        intensities.append(intensity if intensity is not None else np.full(len(world), 0.5, np.float32))
        colors.append(rgb)
        stations.append({"name": path.stem, "position": translation.tolist()})
    origin = np.floor(np.median([s["position"] for s in stations], axis=0))
    points = (np.concatenate(worlds) - origin).astype(np.float32)
    del worlds
    intensity = np.concatenate(intensities).astype(np.float32)
    low, high = np.percentile(intensity[:: max(1, len(intensity) // 1_000_000)], [1, 99])
    grey = (np.clip((intensity - low) / max(high - low, 1e-6), 0, 1) * 255).astype(np.uint8)
    rgb = None
    if all(c is not None for c in colors):
        rgb = np.concatenate(colors)
        if rgb.max() > 255:
            rgb = rgb / 256
        rgb = rgb.astype(np.uint8)
    for station in stations:
        station["position"] = (np.asarray(station["position"]) - origin).tolist()
    return points, grey, rgb, origin, stations


class Writer:
    def __init__(self, out, chunk_bytes):
        self.dir = out / "chunks"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.chunk_bytes = chunk_bytes
        self.index = 0
        self.offset = 0
        self.file = open(self.dir / "0.bin", "wb")
        self.raw_total = 0
        self.total = 0

    def write(self, data):
        packed = gzip.compress(data, 6)
        if self.offset and self.offset + len(packed) > self.chunk_bytes:
            self.file.close()
            self.index += 1
            self.offset = 0
            self.file = open(self.dir / f"{self.index}.bin", "wb")
        self.file.write(packed)
        where = (self.index, self.offset, len(packed))
        self.offset += len(packed)
        self.raw_total += len(data)
        self.total += len(packed)
        return where

    def close(self):
        self.file.close()


def encode(points, colors, bmin, size):
    quantized = np.clip((points - bmin) / size * 65535 + 0.5, 0, 65535).astype(np.uint16)
    return quantized[:, 0].tobytes() + quantized[:, 1].tobytes() + quantized[:, 2].tobytes() + colors.tobytes()


def build(args):
    paths = sorted(Path(p) for p in args.inputs)
    points, grey, rgb, origin, stations = load_all(paths)
    colors = rgb if rgb is not None else grey
    print(f"total: {len(points):,} points", flush=True)

    order = np.random.default_rng(0).permutation(len(points))
    points, colors = points[order], colors[order]
    del order

    low, high = points.min(axis=0).astype(np.float64), points.max(axis=0).astype(np.float64)
    cube = float((high - low).max()) * 1.0001
    grid = args.grid
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    writer = Writer(out, args.chunk_mb * 1024 * 1024)
    nodes = []
    kept_total = 0

    stack = [("", np.arange(len(points)), low, cube)]
    while stack:
        key, idx, bmin, size = stack.pop()
        spacing = size / grid
        cell = np.minimum(((points[idx] - bmin) / size * grid).astype(np.int64), grid - 1)
        code = cell[:, 0] + cell[:, 1] * grid + cell[:, 2] * grid * grid
        _, first = np.unique(code, return_index=True)
        mask = np.zeros(len(idx), dtype=bool)
        mask[first] = True
        rest = idx[~mask]
        is_leaf = spacing <= args.min_spacing
        if not is_leaf and len(rest) < args.min_node:
            mask[:] = True
            rest = rest[:0]
            is_leaf = True
        kept = idx[mask]
        chunk, offset, length = writer.write(encode(points[kept], colors[kept], bmin, size))
        kept_total += len(kept)
        nodes.append([key, int(len(kept)), chunk, offset, length])
        if is_leaf or not len(rest):
            continue
        half = size / 2
        octant = ((points[rest] - bmin) >= half).astype(np.int8)
        child = octant[:, 0] + octant[:, 1] * 2 + octant[:, 2] * 4
        for c in range(8):
            subset = rest[child == c]
            if len(subset):
                shift = np.array([c & 1, (c >> 1) & 1, (c >> 2) & 1], dtype=np.float64) * half
                stack.append((key + str(c), subset, bmin + shift, half))

    writer.close()
    metadata = {
        "name": args.name,
        "origin": origin.tolist(),
        "crs": args.crs,
        "bmin": low.tolist(),
        "size": cube,
        "grid": grid,
        "color": "rgb" if rgb is not None else "intensity",
        "points": kept_total,
        "sourcePoints": int(len(points)),
        "chunks": writer.index + 1,
        "stations": stations,
        "nodes": nodes,
    }
    with gzip.open(out / "metadata.json.gz", "wt") as f:
        json.dump(metadata, f, separators=(",", ":"))
    print(
        f"kept {kept_total:,}/{len(points):,} points in {len(nodes):,} nodes, "
        f"{writer.total / 1e6:.0f} MB gz ({writer.raw_total / 1e6:.0f} MB raw), {writer.index + 1} chunk(s), "
        f"cube {cube:.1f} m, depth {max(len(n[0]) for n in nodes)}"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+")
    parser.add_argument("--out", required=True)
    parser.add_argument("--name", default="Nuage de points")
    parser.add_argument("--crs", default=None)
    parser.add_argument("--grid", type=int, default=128)
    parser.add_argument("--min-spacing", type=float, default=0.005, help="finest grid cell in metres")
    parser.add_argument("--min-node", type=int, default=2000, help="merge remaining points below this count")
    parser.add_argument("--chunk-mb", type=int, default=400)
    build(parser.parse_args())
