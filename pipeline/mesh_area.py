#!/usr/bin/env python3
"""Turn the points of one area of the abbey into a surface for the headset (prototype of a surface mode).

Reads the octrees from their public addresses, leaves out what the masks and the hand cleaning took away,
rebuilds surfaces with Poisson reconstruction, keeps only what lies close to real points, lightens the result
and writes it as <name>.bin.gz: a Uint32 header size, a JSON header, then for each tile positions (Float32),
normals (Int8), tones (Uint8) and triangles (Uint32). Working tile by tile keeps memory within what a Sandbox has.
"""
import argparse
import gzip
import json
import struct
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import fast_simplification
import numpy as np
import open3d as o3d
from scipy.spatial import cKDTree

BASE = 'https://earmm4k9vwqulmnw.public.blob.vercel-storage.com/abbaye'
MIN_TONE = 0.08 * 255
NORMAL_REACH, NORMAL_POINTS = 0.1, 30
# Poisson closes every hole it finds: what is farther than this from any measured point was invented.
MAX_GAP = 0.06
MIN_PIECE_TRIANGLES = 50
# Each tile is rebuilt with what surrounds it, so that no false edge appears at its limit.
TILE_MARGIN, TILE_OVERLAP = 1.0, 0.01
TONE_NEIGHBOURS = 6
PARALLEL = 48
started = time.time()


def log(*args):
    print(f'{time.time() - started:7.0f} s', *args, flush=True)


def fetch(url, byte_range=None):
    request = urllib.request.Request(url, headers={'Range': f'bytes={byte_range[0]}-{byte_range[1]}'} if byte_range else {})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except Exception:
            if attempt == 4:
                raise
            time.sleep(1 + attempt)


def gunzip(data):
    return gzip.decompress(data) if data[:2] == b'\x1f\x8b' else data


def node_box(key, root):
    size, low = root, np.full(3, -root / 2)
    for digit in key:
        size /= 2
        c = int(digit)
        low = low + np.array([c & 1, (c >> 1) & 1, (c >> 2) & 1]) * size
    return low, size


def load_mask(path):
    buffer = Path(path).read_bytes()
    size = struct.unpack('<I', buffer[:4])[0]
    header = json.loads(buffer[4:4 + size])
    start = 4 + (size + 3) // 4 * 4
    return header, np.frombuffer(buffer, dtype='<u4', offset=start)


def cells_of(points, header):
    width, depth = header['shape'][:2]
    cell = np.floor((points - np.array(header['low'])) / header['voxel']).astype(np.int64)
    return cell[:, 0] + cell[:, 1] * width + cell[:, 2] * width * depth


def read_points(box_low, box_high, max_depth):
    manifest = json.loads(fetch(f'{BASE}/manifest.json'))
    root = manifest['rootSize']
    with ThreadPoolExecutor(PARALLEL) as pool:
        zones = list(pool.map(lambda zone: {**zone, **json.loads(gunzip(fetch(f"{BASE}/{zone['id']}/metadata.json.gz")))}, manifest['zones']))
    wanted, stations = [], []
    for zone in zones:
        stations += [station['position'] for station in zone['stations']]
        for key, count, chunk, offset, length in zone['nodes']:
            if len(key) > max_depth or not count:
                continue
            low, size = node_box(key, root)
            if np.all(low < box_high) and np.all(low + size > box_low):
                wanted.append((zone['id'], low, size, count, chunk, offset, length))
    log(len(wanted), 'nodes,', round(sum(n[6] for n in wanted) / 1e9, 2), 'GB')

    def read(node):
        zone, low, size, count, chunk, offset, length = node
        raw = gunzip(fetch(f'{BASE}/{zone}/chunks/{chunk}.bin', (offset, offset + length - 1)))
        axes = np.frombuffer(raw, dtype='<u2', count=count * 3).reshape(3, count).T
        tones = np.frombuffer(raw, dtype='u1', count=count, offset=count * 6)
        points = (low + axes * (size / 65535)).astype(np.float32)
        keep = np.all((points >= box_low) & (points <= box_high), axis=1) & (tones >= MIN_TONE)
        return points[keep], tones[keep]

    with ThreadPoolExecutor(PARALLEL) as pool:
        parts = list(pool.map(read, wanted))
    points = np.concatenate([p for p, _ in parts])
    tones = np.concatenate([t for _, t in parts])
    return points, tones, np.array(stations, dtype=np.float32)


def mesh_tile(points, stations, low, high, args):
    """The surface of one tile, rebuilt with some margin around it and cut back to it. Returns arrays."""
    near = np.all((points >= low - TILE_MARGIN) & (points <= high + TILE_MARGIN), axis=1)
    if near.sum() < 1000:
        return None
    cloud = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(points[near].astype(np.float64)))
    cloud = cloud.voxel_down_sample(args.voxel)
    cloud.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=NORMAL_REACH, max_nn=NORMAL_POINTS))
    samples = np.asarray(cloud.points)
    # Whatever was measured faced a scanner: the nearest one settles which side of the surface is out.
    _, nearest = cKDTree(stations).query(samples)
    normals = np.asarray(cloud.normals)
    normals[np.einsum('ij,ij->i', normals, stations[nearest] - samples) < 0] *= -1
    mesh, _ = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(cloud, depth=args.poisson, scale=1.1, linear_fit=False, n_threads=-1)
    corners = np.asarray(mesh.vertices).astype(np.float32)
    faces = np.asarray(mesh.triangles).astype(np.int32)
    del mesh
    distance, _ = cKDTree(samples).query(corners, workers=-1)
    middles = corners[faces].mean(axis=1)
    keep = (distance[faces] <= MAX_GAP).all(axis=1) & np.all((middles >= low - TILE_OVERLAP) & (middles <= high + TILE_OVERLAP), axis=1)
    used, faces = np.unique(faces[keep], return_inverse=True)
    return corners[used], faces.reshape(-1, 3), len(samples)


def finish_tile(corners, faces, target, points, tones):
    corners, faces = fast_simplification.simplify(corners, faces, target_count=target)
    mesh = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(corners.astype(np.float64)), o3d.utility.Vector3iVector(faces))
    pieces, sizes, _ = mesh.cluster_connected_triangles()
    mesh.remove_triangles_by_mask(np.asarray(sizes)[np.asarray(pieces)] < MIN_PIECE_TRIANGLES)
    mesh.remove_degenerate_triangles()
    mesh.remove_unreferenced_vertices()
    mesh.compute_vertex_normals()
    vertices = np.asarray(mesh.vertices, dtype=np.float32)
    near = np.all((points >= vertices.min(axis=0) - 0.1) & (points <= vertices.max(axis=0) + 0.1), axis=1)
    gaps, found = cKDTree(points[near]).query(vertices, k=TONE_NEIGHBOURS, workers=-1)
    weights = 1 / (gaps + 0.005)
    shade = (tones[near][found] * weights).sum(axis=1) / weights.sum(axis=1)
    return vertices, np.asarray(mesh.vertex_normals), np.clip(shade, 0, 255).astype(np.uint8), np.asarray(mesh.triangles, dtype=np.uint32)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name')
    parser.add_argument('--low', type=float, nargs=3, required=True)
    parser.add_argument('--high', type=float, nargs=3, required=True)
    parser.add_argument('--masks', default='.')
    parser.add_argument('--depth', type=int, default=8, help='deepest level of the octrees to read')
    parser.add_argument('--voxel', type=float, default=0.015)
    parser.add_argument('--poisson', type=int, default=10)
    parser.add_argument('--tile', type=float, default=8)
    parser.add_argument('--triangles', type=int, default=3_000_000)
    args = parser.parse_args()
    box_low, box_high = np.array(args.low), np.array(args.high)
    report = {'name': args.name, 'low': args.low, 'high': args.high, 'voxel': args.voxel, 'poisson': args.poisson, 'tile': args.tile}

    points, tones, stations = read_points(box_low - TILE_MARGIN, box_high + TILE_MARGIN, args.depth)
    report['pointsRead'] = len(points)
    log(len(points), 'points read')
    people, people_cells = load_mask(Path(args.masks) / 'people-mask.bin')
    cleaning = json.loads(fetch(f'{BASE}/nettoyage.json?v={int(time.time())}'))
    removed = np.setdiff1d(np.union1d(people_cells, np.array(cleaning['added'], dtype=np.uint32)), np.array(cleaning['restored'], dtype=np.uint32))
    keep = ~np.isin(cells_of(points, people), removed)
    for name in ('air-mask.bin', 'speck-mask.bin'):
        header, cells = load_mask(Path(args.masks) / name)
        keep &= ~np.isin(cells_of(points, header), cells)
    points, tones = points[keep], tones[keep]
    log(len(points), 'after the masks')

    counts = np.maximum(np.ceil((box_high - box_low)[:2] / args.tile).astype(int), 1)
    work = Path('tiles')
    work.mkdir(exist_ok=True)
    trimmed, samples = [], 0
    for ix in range(counts[0]):
        for iy in range(counts[1]):
            step = (box_high - box_low)[:2] / counts
            low = np.array([box_low[0] + ix * step[0], box_low[1] + iy * step[1], box_low[2]], dtype=np.float32)
            high = np.array([low[0] + step[0], low[1] + step[1], box_high[2]], dtype=np.float32)
            result = mesh_tile(points, stations, low, high, args)
            if result is None:
                continue
            path = work / f'{ix}_{iy}.npz'
            np.savez(path, corners=result[0], faces=result[1])
            trimmed.append((path, len(result[1])))
            samples += result[2]
            log(path.stem, len(result[1]), 'triangles near real points,', result[2], 'samples')
    total = sum(count for _, count in trimmed)
    report.update(samples=samples, trianglesTrimmed=total)

    tiles, parts = [], []
    for path, count in trimmed:
        data = np.load(path)
        vertices, normals, shade, triangles = finish_tile(data['corners'], data['faces'], max(1000, int(args.triangles * count / total)), points, tones)
        tiles.append({'vertices': len(vertices), 'triangles': len(triangles)})
        parts += [vertices.tobytes(), np.clip(normals * 127, -127, 127).astype(np.int8).tobytes(), shade.tobytes(), triangles.tobytes()]
        log(path.stem, len(triangles), 'triangles after lightening')
    header = json.dumps({'tiles': tiles, 'low': args.low, 'high': args.high}).encode()
    header += b' ' * (-(len(header) + 4) % 4)
    Path(f'{args.name}.bin.gz').write_bytes(gzip.compress(b''.join([struct.pack('<I', len(header)), header, *parts]), 6))
    report.update(tiles=len(tiles), triangles=sum(t['triangles'] for t in tiles), bytes=Path(f'{args.name}.bin.gz').stat().st_size, seconds=round(time.time() - started))
    Path(f'{args.name}.json').write_text(json.dumps(report, indent=1))
    log('REPORT', json.dumps(report))


if __name__ == '__main__':
    main()
