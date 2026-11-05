"""Read the coarse levels of the published octrees back from Blob, for analyses that work on the whole abbey.

Isolated points always end up in the coarse levels, since a cell holding nothing yet keeps the first point
that falls in it. Levels up to COARSE_DEPTH (6.25 cm between points) are thus enough to see all of them.
"""
import gzip
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

BASE_URL = "https://earmm4k9vwqulmnw.public.blob.vercel-storage.com/abbaye"
COARSE_DEPTH = 6
ROOT_SIZE = 512.0


def fetch(url, start=None, end=None):
    headers = {"Range": f"bytes={start}-{end}"} if start is not None else {}
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as response:
                return response.read()
        except OSError:
            if attempt == 4:
                raise


def gunzip(data):
    return gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data


def load_manifest():
    zones = json.loads(fetch(f"{BASE_URL}/manifest.json"))["zones"]
    for zone in zones:
        zone.update(json.loads(gunzip(fetch(f"{BASE_URL}/{zone['id']}/metadata.json.gz"))))
    return zones


def node_box(key):
    size, low = ROOT_SIZE, np.full(3, -ROOT_SIZE / 2)
    for digit in key:
        size /= 2
        low = low + size * np.array([int(digit) & 1, (int(digit) >> 1) & 1, (int(digit) >> 2) & 1])
    return low, size


def read_node(zone_id, node):
    key, count, chunk, offset, length = node
    data = gunzip(fetch(f"{BASE_URL}/{zone_id}/chunks/{chunk}.bin", offset, offset + length - 1))
    axes = np.frombuffer(data, "<u2", count * 3).reshape(3, count).T
    tones = np.frombuffer(data, "u1", count, count * 6)
    low, size = node_box(key)
    return (axes / 65535.0 * size + low).astype(np.float32), tones


def zone_points(zone, cache):
    """Positions and tones of the coarse levels of a zone, kept in a scratch directory between runs."""
    path = Path(cache) / f"{zone['id']}.npz"
    if path.exists():
        saved = np.load(path)
        return saved["points"], saved["tones"]
    nodes = [n for n in zone["nodes"] if n[1] and len(n[0]) <= COARSE_DEPTH]
    with ThreadPoolExecutor(12) as pool:
        parts = list(pool.map(lambda n: read_node(zone["id"], n), nodes))
    points = np.concatenate([p for p, _ in parts])
    tones = np.concatenate([t for _, t in parts])
    np.savez(path, points=points, tones=tones)
    return points, tones


if __name__ == "__main__":
    cache = Path(sys.argv[1])
    cache.mkdir(parents=True, exist_ok=True)
    for zone in load_manifest():
        points, _ = zone_points(zone, cache)
        print(zone["id"], len(points), flush=True)
