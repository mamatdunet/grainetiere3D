"""List the cells holding the survey crew: the people and tripods the scanners caught while working.

Whatever is part of the building shows as large level planes (floors, vaults) or as tall vertical runs (walls).
Under each scanner position, what remains may be a tripod when it fits the cone of the legs, in a few narrow
directions only. Anything else left over is a piece: it counts as a person only if it stands on a floor at about
a person's height, away from the walls and from other clutter, and, above all, if a single scanner saw all of it,
as a shell with no back, while other scanners had a clear view from elsewhere and saw no other side of it.
Real objects, even thin or small, were seen from several sides and fail that last test.

The cells of these pieces, with one cell around them for the finer points, go in people-mask.bin.
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

from coarse_points import load_manifest, zone_points
from plan_tour import MIN_TONE, without_masked

VOXEL = 0.1
BOUNDS = ((-60, 70), (-50, 70))
PLANE_WIDTH = 9
PLANE_SHARE = 0.55
WALL_RUN = 21
FLOOR_REACH = 7
WALL_REACH = (5, 5, 3)
FULL = np.ones((3, 3, 3), bool)
# Tripods: height of the scanner above the floor, reach of the legs, narrow directions.
TRIPOD_HEIGHT = (0.5, 2.0)
LEG_ANGLES = np.radians(np.arange(0, 360, 10))
LEG_REACHES = np.arange(0.2, 1.05, 0.1)
LEG_WIDTH, MIN_LEG_APART = 0.13, np.radians(50)
LEG_CLEARANCE, LEG_CLUTTER = 0.35, 1.0
MIN_LEG_LAYERS, LEG_COVER = 4, 0.4
FLOOR_DISC, FLOOR_SHARE = 1.2, 0.6
# People.
MIN_CELLS, MIN_LAYERS = 20, 8
BASE_MAX, TOP_RANGE = 0.5, (1.0, 2.1)
MAX_LENGTH, MAX_WIDTH = 5.0, 2.0
# Longer than a person only as the thin sheet left by someone walking during the scan.
LONG, LONG_WIDTH = 2.5, 0.4
MAX_CONTACT, MAX_CROWD, CROWD_MARGIN = 0.3, 3.0, 5
MIN_SINGLE, SHELL_DEPTH, RAY_BIN = 0.85, 0.15, 0.12
# Out under the sky a false positive costs little, and a person next to a tripod seen from two sides is common.
OPEN_SINGLE, OPEN_TOP, OPEN_LENGTH, OPEN_WIDTH, OPEN_CROWD = 0.65, 1.3, 1.8, 1.3, 1.5
MIN_LENGTH = 0.25
WIDE, WIDE_SINGLE = 0.6, 0.93
SKY_CELLS = 120
MIN_WITNESS_ANGLE, WITNESS_RANGE, SIGHT_RANGE = 30.0, 20.0, 30.0
MAX_FILL = 0.75
SCRAP_CELLS, SCRAP_REACH = 25, 2


def load_points(zones, cache, mask_paths):
    clouds = []
    for zone in zones:
        points, tones = zone_points(zone, cache)
        clouds.append(points[tones >= MIN_TONE])
    points = without_masked(np.concatenate(clouds), mask_paths)
    extent = np.floor(points.min(axis=0) / VOXEL) * VOXEL, np.floor((points.max(axis=0) - points.min(axis=0)) / VOXEL).astype(int) + 2
    return extent, points[(points[:, 0] > BOUNDS[0][0]) & (points[:, 0] < BOUNDS[0][1]) & (points[:, 1] > BOUNDS[1][0]) & (points[:, 1] < BOUNDS[1][1])]


def structure(occupied):
    shape = occupied.shape
    planes = np.zeros(shape, bool)
    for z in range(shape[2] - 1):
        layer = occupied[:, :, z] | occupied[:, :, z + 1]
        if layer.sum() >= 20:
            planes[:, :, z] = layer & (ndimage.uniform_filter(layer.astype(np.float32), PLANE_WIDTH, mode="constant") > PLANE_SHARE)
    return planes, tall_runs(occupied)


def tall_runs(occupied):
    """Cells on an unbroken vertical run of at least WALL_RUN, small gaps closed."""
    shape = occupied.shape
    closed = ndimage.binary_closing(occupied, structure=np.ones((1, 1, 3), bool))
    runs, up, down = np.zeros(shape, np.int16), np.zeros(shape[:2], np.int16), np.zeros(shape[:2], np.int16)
    for z in range(shape[2]):
        up = (up + 1) * closed[:, :, z]
        runs[:, :, z] = up
    for z in range(shape[2] - 1, -1, -1):
        down = (down + 1) * closed[:, :, z]
        runs[:, :, z] += down
    return runs >= WALL_RUN


def heights_over_floor(planes):
    shape = planes.shape
    floor = ndimage.binary_dilation(planes, structure=np.ones((FLOOR_REACH, FLOOR_REACH, 1), bool))
    above, last = np.zeros(shape, np.int16), np.full(shape[:2], -1000, np.int16)
    for z in range(shape[2]):
        last = np.where(floor[:, :, z], z, last)
        above[:, :, z] = np.clip(z - last, 0, 1000)
    return above


def legs_of(cells, at, bottom):
    """Straight legs running down and outwards from below the scanner: cells on up to three of them."""
    off = (cells[:, :2] - at[:2]) * VOXEL
    drop = (at[2] - cells[:, 2]) / (at[2] - bottom)
    free = np.ones(len(cells), bool)
    legs, chosen = [], []
    for _ in range(3):
        best, best_hits, best_angle = 0, None, None
        for angle in LEG_ANGLES:
            if any(abs((angle - other + np.pi) % (2 * np.pi) - np.pi) < MIN_LEG_APART for other in chosen):
                continue
            for reach in LEG_REACHES:
                line = np.c_[np.cos(angle) * drop * reach, np.sin(angle) * drop * reach]
                gap = np.hypot(*(off - line).T)
                hits = free & (gap <= LEG_WIDTH)
                # A real leg stands in the air, not along the edge of a piece of furniture; near the top all legs meet.
                if ((gap > LEG_WIDTH) & (gap <= LEG_CLEARANCE) & (drop > 0.5)).sum() > LEG_CLUTTER * (hits & (drop > 0.5)).sum():
                    continue
                # A leg shows at many heights, and does not stop near the top only.
                layers = len(np.unique(cells[hits, 2]))
                if layers > best and drop[hits].max(initial=0) > 0.6:
                    best, best_hits, best_angle = layers, hits, angle
        if best < max(MIN_LEG_LAYERS, LEG_COVER * (at[2] - bottom)):
            break
        legs.append(best_hits)
        chosen.append(best_angle)
        free &= ~best_hits
    return legs


def tripods(rest, above, planes, stations, low):
    """Legs below each scanner, on a real floor, when at least two of them show as straight lines."""
    found = np.zeros(rest.shape, bool)
    reach = int(np.ceil(max(LEG_REACHES[-1] + LEG_WIDTH, FLOOR_DISC) / VOXEL))
    xx, yy = np.mgrid[-reach:reach + 1, -reach:reach + 1]
    disc = xx**2 + yy**2 <= (FLOOR_DISC / VOXEL) ** 2
    kept = 0
    for station in stations:
        at = ((station - low) / VOXEL).astype(int)
        if np.any(at < reach) or np.any(at >= np.array(rest.shape) - reach):
            continue
        height = above[at[0], at[1], at[2]] * VOXEL
        if not TRIPOD_HEIGHT[0] <= height <= TRIPOD_HEIGHT[1]:
            continue
        bottom = at[2] - int(height / VOXEL)
        if planes[xx[disc] + at[0], yy[disc] + at[1], bottom - 2:bottom + 2].any(axis=1).mean() < FLOOR_SHARE:
            continue
        box = rest[at[0] - reach:at[0] + reach + 1, at[1] - reach:at[1] + reach + 1, bottom + 1:at[2] + 1]
        cells = np.argwhere(box) + [at[0] - reach, at[1] - reach, bottom + 1]
        if len(cells) < MIN_LEG_LAYERS:
            continue
        legs = legs_of(cells, at, bottom)
        if len(legs) >= 2:
            hit = cells[np.any(legs, axis=0)]
            found[hit[:, 0], hit[:, 1], hit[:, 2]] = True
            kept += 1
    return found, kept


def blocked(occupied, low, start, end):
    """Occupied cells on the way from a scanner to a point, leaving out both ends."""
    way = end - start
    length = np.linalg.norm(way)
    steps = int((length - 0.65) / VOXEL)
    if steps <= 0:
        return 0
    cells = ((start + (0.4 + np.arange(steps) * VOXEL)[:, None] / length * way - low) / VOXEL).astype(int)
    cells = cells[np.all((cells >= 0) & (cells < occupied.shape), axis=1)]
    return int(occupied[cells[:, 0], cells[:, 1], cells[:, 2]].sum())


def one_sided(points, stations, occupied, low):
    """Share of the points forming a single surface for the best scanner, and how many others saw that place."""
    center = points.mean(axis=0)
    distance = np.linalg.norm(stations - center, axis=1)
    near = np.flatnonzero((distance < SIGHT_RANGE) & (distance > 0.3))
    near = near[np.argsort(distance[near])][:60]
    sample = points[np.random.default_rng(0).choice(len(points), min(8, len(points)), replace=False)]
    seen = []
    for s in near:
        if np.mean([blocked(occupied, low, stations[s], p) <= 1 for p in sample]) < 0.5:
            continue
        rays = points - stations[s]
        ranges = np.linalg.norm(rays, axis=1)
        width = RAY_BIN / ranges.mean()
        key = (np.round(np.arctan2(rays[:, 1], rays[:, 0]) / width).astype(np.int64) << 20) + np.round(np.arcsin(rays[:, 2] / ranges) / width).astype(np.int64)
        bins, index = np.unique(key, return_inverse=True)
        nearest = np.full(len(bins), np.inf)
        np.minimum.at(nearest, index, ranges)
        seen.append((float(np.mean(ranges - nearest[index] < SHELL_DEPTH)), int(s)))
    if not seen:
        return 0.0, -1, 0
    single, best = max(seen)
    way = (stations[best] - center)[:2]
    way /= np.linalg.norm(way) + 1e-9
    witnesses = 0
    for _, s in seen:
        other = (stations[s] - center)[:2]
        other /= np.linalg.norm(other) + 1e-9
        if distance[s] < WITNESS_RANGE and np.degrees(np.arccos(np.clip(way @ other, -1, 1))) > MIN_WITNESS_ANGLE:
            witnesses += 1
    return single, best, witnesses


def analyse(points, stations):
    low = np.floor(points.min(axis=0) / VOXEL) * VOXEL
    cell = ((points - low) / VOXEL).astype(np.int32)
    shape = cell.max(axis=0) + 1
    occupied = np.zeros(shape, bool)
    occupied[cell[:, 0], cell[:, 1], cell[:, 2]] = True
    planes, walls = structure(occupied)
    solid = ndimage.binary_dilation(planes, structure=np.ones((1, 1, 3), bool)) | walls
    rest = occupied & ~solid
    above = heights_over_floor(planes)
    legs, tripod_count = tripods(rest, above, planes, stations, low)
    rest_free = rest & ~legs
    near_wall = ndimage.binary_dilation(walls, structure=np.ones(WALL_REACH, bool))
    pieces, count = ndimage.label(rest_free, structure=FULL)
    # Under a roof: a level plane or a wall somewhere up the column, within a few metres.
    ceiling = np.zeros(shape, bool)
    seen_above = np.zeros(shape[:2], np.int16)
    for z in range(shape[2] - 1, -1, -1):
        seen_above = np.where(planes[:, :, z], SKY_CELLS, np.maximum(seen_above - 1, 0))
        ceiling[:, :, z] = seen_above > 0
    of_point = pieces[cell[:, 0], cell[:, 1], cell[:, 2]]
    order = np.argsort(of_point)
    sorted_pieces = of_point[order]
    found = []
    accepted = np.zeros(shape, bool)
    for number, box in enumerate(ndimage.find_objects(pieces), 1):
        if box is None or box[2].stop - box[2].start < MIN_LAYERS:
            continue
        inside = pieces[box] == number
        size = int(inside.sum())
        if size < MIN_CELLS:
            continue
        cells = np.argwhere(inside) + [s.start for s in box]
        over = above[cells[:, 0], cells[:, 1], cells[:, 2]] * VOXEL
        base, top = float(over.min()), float(over.max())
        if base > BASE_MAX or not TOP_RANGE[0] <= top <= TOP_RANGE[1]:
            continue
        flat = cells[:, :2] * VOXEL
        axes = np.linalg.eigh(np.cov((flat - flat.mean(axis=0)).T) + 1e-6 * np.eye(2))[1]
        along = (flat - flat.mean(axis=0)) @ axes
        length, width = float(np.ptp(along[:, 1])), float(np.ptp(along[:, 0]))
        if length > MAX_LENGTH or width > MAX_WIDTH or (length > LONG and width > LONG_WIDTH):
            continue
        contact = float(near_wall[cells[:, 0], cells[:, 1], cells[:, 2]].mean())
        low_box = [max(s.start - CROWD_MARGIN, 0) for s in box]
        high_box = [min(s.stop + CROWD_MARGIN, e) for s, e in zip(box, shape)]
        crowd = (int(rest_free[low_box[0]:high_box[0], low_box[1]:high_box[1], low_box[2]:high_box[2]].sum()) - size) / size
        face = np.unique(np.c_[(along[:, 1] / VOXEL).astype(int), cells[:, 2]], axis=0)
        fill = len(face) / ((np.ptp(face[:, 0]) + 1) * (np.ptp(face[:, 1]) + 1))
        begin, end = np.searchsorted(sorted_pieces, [number, number + 1])
        own = points[order[begin:end]]
        single, best, witnesses = one_sided(own, stations, occupied, low)
        sky = not ceiling[cells[:, 0], cells[:, 1], cells[:, 2]].any()
        ok = contact < MAX_CONTACT and crowd < MAX_CROWD and witnesses >= 1 and fill <= MAX_FILL and length >= MIN_LENGTH
        loose = sky and single >= OPEN_SINGLE and top >= OPEN_TOP and length <= OPEN_LENGTH and width <= OPEN_WIDTH and crowd < OPEN_CROWD
        # A wide piece that is not quite a shell is more likely a thing (a cupboard, a door frame) than a person.
        ok = ok and (single >= (WIDE_SINGLE if width > WIDE else MIN_SINGLE) or loose)
        found.append(dict(i=number, n=size, np=len(own), c=own.mean(axis=0).tolist(), base=base, top=top, L=length, W=width, contact=contact, crowd=crowd, fill=float(fill), single=single, s0=best, wit=witnesses, sky=bool(sky), ok=bool(ok), minor=axes[:, 0].tolist(), floorz=float(cells[:, 2].min() * VOXEL + low[2] - base)))
        if ok:
            accepted[box][inside] = True
    # Scraps: small leftovers right beside a person, away from the walls (a detached arm or foot).
    beside = ndimage.binary_dilation(accepted, structure=FULL, iterations=SCRAP_REACH)
    sizes = np.bincount(pieces.ravel())
    sizes[0] = 0
    scraps = rest_free & beside & (sizes[pieces] < SCRAP_CELLS) & ~near_wall & ~accepted
    core = accepted | legs | scraps
    mask = ndimage.binary_dilation(core) & ~solid
    return dict(low=low, shape=shape, mask=mask, accepted=accepted, legs=legs, scraps=scraps, found=found, tripods=tripod_count, pieces=pieces)


def write_mask(result, extent, path):
    """Numbered on a grid over all the points, as the viewer computes a number for each point it loads."""
    low, shape = extent
    x, y, z = (np.nonzero(result["mask"]) + np.round((result["low"] - low) / VOXEL).astype(np.int64)[:, None])
    numbers = np.sort(x + y * shape[0] + z * shape[0] * shape[1]).astype("<u4")
    header = json.dumps({"voxel": VOXEL, "low": low.tolist(), "shape": shape.tolist()}).encode()
    with open(path, "wb") as out:
        np.array([len(header)], "<u4").tofile(out)
        out.write(header.ljust((len(header) + 3) // 4 * 4))
        numbers.tofile(out)


if __name__ == "__main__":
    cache, output, mask_paths = sys.argv[1], Path(sys.argv[2]), sys.argv[3:]
    zones = load_manifest()
    stations = np.array([s["position"] for z in zones for s in z["stations"]], float)
    extent, points = load_points(zones, cache, mask_paths)
    result = analyse(points, stations)
    write_mask(result, extent, output)
    print("pièces examinées", len(result["found"]), "personnes", sum(f["ok"] for f in result["found"]), "trépieds", result["tripods"])
    print("cellules", int(result["mask"].sum()), "taille", output.stat().st_size / 1e3, "ko")
