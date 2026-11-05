#!/usr/bin/env python3
"""Convert one zone of the abbey straight from Drive to Vercel Blob, inside a Vercel Sandbox.

Every zone shares one world octree (fixed root cube), so zones can be converted separately
and overlaid by the viewer. Peak disk stays low: each scan is deleted once it has been binned
into 16 m tiles, each tile once it has been built, each chunk once it has been uploaded.

Requires: rclone on PATH with a configured remote, BLOB_READ_WRITE_TOKEN in the environment.
"""
import argparse
import fcntl
import gzip
import json
import os
import re
import resource
import statistics
import subprocess
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import pye57
from scipy.spatial import cKDTree

GRID = 128
ROOT_SIZE = 512.0
TILE_DEPTH = 5
TILE_SIZE = ROOT_SIZE / 2**TILE_DEPTH
MIN_SPACING = 0.005
MIN_NODE = 2000
READ_POINTS = 8_000_000
CHUNK_BYTES = 90 * 1024 * 1024
BIG_TILE_BYTES = 200_000_000
RECORD = np.dtype([("x", "<u2"), ("y", "<u2"), ("z", "<u2"), ("i", "u1")])
BLOB_API = "https://vercel.com/api/blob/"


def zone_of(path):
    name = re.sub(r"_?\d+\.e57$", "", path.split("/")[-1], flags=re.I).lower()
    return name.removeprefix("ag_")


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def upload(path, pathname):
    command = [
        "curl", "-sS", "--fail-with-body", "--retry", "5", "--retry-all-errors", "-X", "PUT",
        "--upload-file", str(path),
        "-H", "@" + os.environ["BLOB_HEADERS"],
        "-H", "x-add-random-suffix: 0",
        "-H", "x-allow-overwrite: 1",
        "-H", "x-content-type: application/octet-stream",
        f"{BLOB_API}?pathname={pathname}",
    ]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)


class Writer:
    def __init__(self, work, prefix):
        self.work = work
        self.prefix = prefix
        self.index = 0
        self.offset = 0
        self.total = 0
        self.path = work / "chunk.bin"
        self.file = open(self.path, "wb")

    def flush(self):
        self.file.close()
        upload(self.path, f"{self.prefix}/chunks/{self.index}.bin")
        self.path.unlink()

    def write(self, data):
        packed = gzip.compress(data, 4)
        if self.offset and self.offset + len(packed) > CHUNK_BYTES:
            self.flush()
            self.index += 1
            self.offset = 0
            self.file = open(self.path, "wb")
        self.file.write(packed)
        where = (self.index, self.offset, len(packed))
        self.offset += len(packed)
        self.total += len(packed)
        return where

    def close(self):
        self.flush()


def encode(points, tones, node_min, size):
    q = np.clip((points - node_min) / size * 65535 + 0.5, 0, 65535).astype(np.uint16)
    return q[:, 0].tobytes() + q[:, 1].tobytes() + q[:, 2].tobytes() + tones.tobytes()


def voxel_code(points):
    cells = (points / MIN_SPACING).astype(np.int64)
    return (cells[:, 0] << 42) | (cells[:, 1] << 21) | cells[:, 2]


def bin_scan(path, tiles_dir, root_min, pairs_needed, crops):
    e57 = pye57.E57(str(path))
    header = e57.get_header(0)
    rotation = np.asarray(header.rotation_matrix).T
    translation = np.asarray(header.translation) - root_min
    fields = ["cartesianX", "cartesianY", "cartesianZ", "intensity", "cartesianInvalidState"]
    # The largest scans hold 170 M points: read them in slices and thin each slice right away.
    data, buffers = e57.make_buffers(fields, READ_POINTS)
    reader = header.points.reader(buffers)
    worlds, greys = [], []
    near_parts = [[] for _ in pairs_needed]
    # A scan taken in a small room is almost entirely near the midpoint: thin the crops as they come.
    near_step = max(1, header.point_count // 8_000_000)
    source = 0
    while True:
        count = reader.read()
        if not count:
            break
        valid = data["cartesianInvalidState"][:count] == 0
        xyz = np.column_stack([data[f][:count][valid] for f in fields[:3]])
        slice_world = xyz @ rotation + translation
        slice_tone = data["intensity"][:count][valid]
        source += len(slice_world)
        inside = ((slice_world >= 0) & (slice_world < ROOT_SIZE)).all(axis=1)
        slice_world, slice_tone = slice_world[inside], slice_tone[inside]
        for part, midpoint in zip(near_parts, pairs_needed):
            near = slice_world[::near_step]
            part.append(near[np.linalg.norm(near - midpoint, axis=1) < 4].astype(np.float32))
        code = voxel_code(slice_world)
        _, first = np.unique(code, return_index=True)
        worlds.append(slice_world[first].astype(np.float32))
        greys.append((np.clip((slice_tone[first] - 0.2) / 0.8, 0, 1) * 255).astype(np.uint8))
    reader.close()
    del data, buffers

    for part, midpoint in zip(near_parts, pairs_needed):
        crop = np.concatenate(part)
        if len(crop) > 3_000_000:
            crop = crop[:: len(crop) // 3_000_000 + 1]
        crops[tuple(midpoint)].append(crop)
    del near_parts

    world = np.concatenate(worlds)
    grey = np.concatenate(greys)
    del worlds, greys
    _, first = np.unique(voxel_code(world), return_index=True)
    world, grey = world[first], grey[first]
    del first

    tile = (world / TILE_SIZE).astype(np.int32)
    code = tile[:, 0] * 1024 * 1024 + tile[:, 1] * 1024 + tile[:, 2]
    order = np.argsort(code, kind="stable")
    code, tile, world, grey = code[order], tile[order], world[order], grey[order]
    del order
    starts = np.flatnonzero(np.r_[True, code[1:] != code[:-1]])
    for start, end in zip(starts, np.r_[starts[1:], len(code)]):
        ix, iy, iz = tile[start]
        local = (world[start:end] - np.array([ix, iy, iz]) * TILE_SIZE) / TILE_SIZE
        q = np.clip(local * 65535 + 0.5, 0, 65535).astype(np.uint16)
        rows = np.empty(end - start, RECORD)
        rows["x"], rows["y"], rows["z"], rows["i"] = q[:, 0], q[:, 1], q[:, 2], grey[start:end]
        with open(tiles_dir / f"{ix}_{iy}_{iz}.bin", "ab") as f:
            rows.tofile(f)
    return source, len(world)


def tile_key(ix, iy, iz):
    key = ""
    for bit in range(TILE_DEPTH - 1, -1, -1):
        key += str(((ix >> bit) & 1) + 2 * ((iy >> bit) & 1) + 4 * ((iz >> bit) & 1))
    return key


def first_per_cell(points, node_min, size):
    cell = np.minimum(((points - node_min) / size * GRID).astype(np.int64), GRID - 1)
    code = cell[:, 0] + cell[:, 1] * GRID + cell[:, 2] * GRID * GRID
    _, first = np.unique(code, return_index=True)
    return first


def unique_rows(rows):
    """Keep one point per finest octree cell (16 quantization units), whichever scan it came from."""
    code = (rows["x"].astype(np.int64) >> 4 << 24) | (rows["y"].astype(np.int64) >> 4 << 12) | (rows["z"] >> 4)
    _, first = np.unique(code, return_index=True)
    return rows[first]


def merged_tile(path):
    """Merge the scans of one tile. Overlapping scans can stack hundreds of millions of records
    in a single tile: those are split on disk first, so that each part fits in memory."""
    if path.stat().st_size <= BIG_TILE_BYTES:
        return unique_rows(np.fromfile(path, RECORD))
    parts_dir = path.with_suffix(".parts")
    parts_dir.mkdir()
    with open(path, "rb") as f:
        while True:
            rows = np.fromfile(f, RECORD, BIG_TILE_BYTES // RECORD.itemsize)
            if not len(rows):
                break
            part = (rows["x"] >> 13) * 64 + (rows["y"] >> 13) * 8 + (rows["z"] >> 13)
            for value in np.unique(part):
                with open(parts_dir / f"{value}.bin", "ab") as out:
                    rows[part == value].tofile(out)
    merged = []
    for part_path in sorted(parts_dir.iterdir()):
        merged.append(unique_rows(np.fromfile(part_path, RECORD)))
        part_path.unlink()
    parts_dir.rmdir()
    return np.concatenate(merged)


class HeavyLock:
    """Only one worker of the sandbox at a time may hold a big tile in memory."""

    def __init__(self, path, needed):
        self.file = open(path, "w") if needed else None

    def __enter__(self):
        if self.file:
            fcntl.flock(self.file, fcntl.LOCK_EX)

    def __exit__(self, *_):
        if self.file:
            self.file.close()


def build_tile(path, writer, nodes, coarse):
    ix, iy, iz = map(int, path.stem.split("_"))
    rows = merged_tile(path)
    points = np.column_stack([rows["x"], rows["y"], rows["z"]]).astype(np.float32) / 65535 * TILE_SIZE
    tones = rows["i"]
    del rows
    order = np.random.default_rng(ix * 1000003 + iy * 1009 + iz).permutation(len(points))
    points, tones = points[order], tones[order]
    del order
    key = tile_key(ix, iy, iz)
    tile_min = np.array([ix, iy, iz], dtype=np.float64) * TILE_SIZE

    # Levels above the tile are shared with neighbouring tiles: gather them for later.
    keep = np.ones(len(points), dtype=bool)
    for depth in range(TILE_DEPTH):
        prefix = key[:depth]
        size = ROOT_SIZE / 2**depth
        cube = node_min_from_key(prefix)
        remaining = np.flatnonzero(keep)
        if not len(remaining):
            break
        first = first_per_cell(points[remaining] + tile_min, cube, size)
        chosen = remaining[first]
        keep[chosen] = False
        coarse[prefix].append((points[chosen] + tile_min, tones[chosen]))

    stack = [(key, np.flatnonzero(keep).astype(np.int64), np.zeros(3), TILE_SIZE)]
    del keep
    kept = 0
    while stack:
        node, idx, node_min, size = stack.pop()
        if not len(idx):
            continue
        first = first_per_cell(points[idx], node_min, size)
        mask = np.zeros(len(idx), dtype=bool)
        mask[first] = True
        rest = idx[~mask]
        leaf = size / GRID <= MIN_SPACING
        if not leaf and len(rest) < MIN_NODE:
            mask[:] = True
            rest = rest[:0]
            leaf = True
        chosen = idx[mask]
        chunk, offset, length = writer.write(encode(points[chosen], tones[chosen], node_min, size))
        nodes.append([node, int(len(chosen)), chunk, offset, length])
        kept += len(chosen)
        if leaf or not len(rest):
            continue
        half = size / 2
        octant = (points[rest] - node_min) >= half
        child = octant[:, 0] * 1 + octant[:, 1] * 2 + octant[:, 2] * 4
        for c in range(8):
            subset = rest[child == c]
            if len(subset):
                shift = np.array([c & 1, (c >> 1) & 1, (c >> 2) & 1]) * half
                stack.append((node + str(c), subset, node_min + shift, half))
    return kept


def node_min_from_key(key):
    node_min = np.zeros(3)
    size = ROOT_SIZE
    for digit in key:
        size /= 2
        c = int(digit)
        node_min = node_min + np.array([c & 1, (c >> 1) & 1, (c >> 2) & 1]) * size
    return node_min


def plane_gaps(crops):
    """Median distance between one scan's surfaces and the planes fitted on its neighbour."""
    rng = np.random.default_rng(0)
    results = []
    for midpoint, clouds in crops.items():
        if len(clouds) != 2 or min(map(len, clouds)) < 50_000:
            continue
        a, b = clouds
        query = a[rng.choice(len(a), min(20000, len(a)), replace=False)]
        distance, index = cKDTree(b).query(query, k=16, distance_upper_bound=0.03)
        ok = np.isfinite(distance).all(axis=1)
        if ok.sum() < 500:
            continue
        neighbours = b[index[ok]]
        center = neighbours.mean(axis=1)
        moved = neighbours - center[:, None, :]
        values, vectors = np.linalg.eigh(np.einsum("nki,nkj->nij", moved, moved) / 16)
        flat = values[:, 0] < 0.15 * values[:, 1]
        gap = np.abs(((query[ok] - center) * vectors[:, :, 0]).sum(axis=1))[flat]
        if len(gap) >= 200:
            results.append(round(float(np.median(gap) * 1000), 2))
    return results


def closest_pairs(stations, count=3):
    names = list(stations)
    pairs = []
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            d = float(np.linalg.norm(stations[a] - stations[b]))
            if d > 0.5:
                pairs.append((d, a, b))
    return sorted(pairs)[:count]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zone")
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--remote", default="grainetiere:")
    parser.add_argument("--work", default="work_zone")
    parser.add_argument("--prefix", default="abbaye")
    parser.add_argument("--heavy-lock", default="heavy.lock")
    args = parser.parse_args()

    inventory = [json.loads(line) for line in open(args.inventory)]
    origin = np.floor(np.median([r["position"] for r in inventory], axis=0))
    root_min = origin - ROOT_SIZE / 2
    entries = sorted((r for r in inventory if zone_of(r["path"]) == args.zone), key=lambda r: r["path"])
    if not entries:
        raise SystemExit(f"unknown zone {args.zone}")

    work = Path(args.work) / args.zone
    tiles = work / "tiles"
    tiles.mkdir(parents=True, exist_ok=True)
    started = time.time()
    positions = {r["path"]: np.array(r["position"]) - root_min for r in entries}
    pairs = closest_pairs(positions)
    wanted = defaultdict(list)
    for _, a, b in pairs:
        mid = (positions[a] + positions[b]) / 2
        wanted[a].append(mid)
        wanted[b].append(mid)
    crops = defaultdict(list)

    source_points = binned = 0
    peak_disk = 0
    for n, entry in enumerate(entries, 1):
        local = work / "scan.e57"
        t0 = time.time()
        subprocess.run(["rclone", "copyto", f"{args.remote}{entry['path']}", str(local)], check=True)
        t1 = time.time()
        source, kept = bin_scan(local, tiles, root_min, wanted.get(entry["path"], []), crops)
        local.unlink()
        source_points += source
        binned += kept
        used = sum(f.stat().st_size for f in tiles.iterdir())
        peak_disk = max(peak_disk, used)
        log(f"{n}/{len(entries)} {entry['path'].split('/')[-1]} {source:,}->{kept:,} "
            f"drive {t1 - t0:.0f}s read {time.time() - t1:.0f}s tiles {used / 1e9:.1f} GB")
    binned_at = time.time()

    writer = Writer(work, f"{args.prefix}/{args.zone}")
    nodes = []
    coarse = defaultdict(list)
    kept_total = 0
    tile_files = sorted(tiles.iterdir(), key=lambda p: p.stat().st_size)
    for n, path in enumerate(tile_files, 1):
        with HeavyLock(args.heavy_lock, path.stat().st_size > BIG_TILE_BYTES):
            kept_total += build_tile(path, writer, nodes, coarse)
        path.unlink()
        if n % 10 == 0 or n == len(tile_files):
            log(f"tile {n}/{len(tile_files)} nodes {len(nodes):,} {writer.total / 1e9:.2f} GB gz")
    for key, parts in sorted(coarse.items()):
        points = np.concatenate([p for p, _ in parts])
        tones = np.concatenate([t for _, t in parts])
        node_min = node_min_from_key(key)
        size = ROOT_SIZE / 2 ** len(key)
        first = first_per_cell(points, node_min, size)
        points, tones = points[first], tones[first]
        chunk, offset, length = writer.write(encode(points.astype(np.float64), tones, node_min, size))
        nodes.append([key, int(len(points)), chunk, offset, length])
        kept_total += len(points)
    writer.close()

    metadata = {
        "zone": args.zone,
        "grid": GRID,
        "rootSize": ROOT_SIZE,
        "points": kept_total,
        "stations": [
            {"name": r["path"].split("/")[-1][:-4], "position": (np.array(r["position"]) - origin).tolist()}
            for r in entries
        ],
        "nodes": nodes,
    }
    meta_path = work / "metadata.json.gz"
    with gzip.open(meta_path, "wt") as f:
        json.dump(metadata, f, separators=(",", ":"))
    upload(meta_path, f"{args.prefix}/{args.zone}/metadata.json.gz")

    gaps = plane_gaps(crops)
    report = {
        "zone": args.zone,
        "scans": len(entries),
        "sourcePoints": int(source_points),
        "binnedPoints": int(binned),
        "keptPoints": int(kept_total),
        "nodes": len(nodes),
        "chunks": writer.index + 1,
        "gzipGB": round(writer.total / 1e9, 3),
        "gapsMm": gaps,
        "gapMedianMm": statistics.median(gaps) if gaps else None,
        "peakTilesGB": round(peak_disk / 1e9, 2),
        "secondsScans": round(binned_at - started),
        "secondsBuild": round(time.time() - binned_at),
        "peakMemoryGB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 1),
    }
    Path(f"report_{args.zone}.json").write_text(json.dumps(report))
    log("REPORT", json.dumps(report))


if __name__ == "__main__":
    main()
