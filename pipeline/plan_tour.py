"""Plan the guided tour from the coarse points: the route, how to walk it, where to look.

The route follows the abbey in order (see ROUTE): places are named stops chosen by hand on the plan, in the
order of the guided visit. A single grid covers the whole abbey. A cell can be walked through when it is far
enough from anything and at eye height above a floor, which leaves tables, furniture and walls out of the way.
When the next place can be reached on foot through what the laser saw, the walk goes on without a cut and
places share one chain of keys; otherwise (closed door, spiral stair), a new chain starts after a fade.
At each stop the gaze sweeps the given target or the most open side; walking, it leans towards the openings.
The result is a list of key positions, one per second at walking speed.
"""
import json
import itertools
import sys

import numpy as np
from scipy import ndimage, sparse
from scipy.sparse import csgraph

from coarse_points import load_manifest, zone_points


def stop(x, y, z=None, look=None, sweep=None, via=False):
    return {"at": (x, y), "z": z, "look": look, "sweep": sweep, "via": via}


# In the order of the visit: outside, through the entrance, the cloister, east, south and west wings,
# the tower of the abbot, then along the west wall to the church, and back through the fields passage.
ROUTE = [
    ("abords", [stop(-38, -19, look=(-24, -2), sweep=100), stop(-27, 7, look=(-13, 3), sweep=120)]),
    ("entree", [stop(-16.5, 3.5, look=(-5, 8), sweep=100), stop(-9, 6, via=True)]),
    ("cloitre", [stop(-3, 12, look=(-7, 14), sweep=200), stop(8, 26, via=True), stop(11, 14, look=(-5, 18)), stop(9, -1, look=(-3, 20))]),
    ("salle_capitulaire", [stop(18, 5, look=(24, 2), sweep=200), stop(23, 1.5, look=(17, 5), sweep=200)]),
    ("sacristie", [stop(25, 10.5, look=(33, 7), sweep=80)]),
    ("refectoire_moines", [stop(14, -14.5, look=(11, -22), sweep=130)]),
    ("salle_saint_benoit", [stop(6, -11, sweep=300)]),
    ("grand_refectoire", [stop(-1, -7, look=(-10, -6), sweep=200), stop(-8, -5, look=(1, -9), sweep=160)]),
    ("boutique", [stop(-18, -4, sweep=300)]),
    ("galerie_ouest", [stop(-16, 7, look=(-10, 25), sweep=160), stop(-12.5, 24, look=(0, 12), sweep=160)]),
    ("galerie_etage", [stop(-15, 10.5, z=3.0, look=(-6, 5.5), sweep=80)]),
    ("ancienne_cuisine", [stop(-26.5, -1, look=(-33, -5), sweep=200)]),
    ("tour_garde", [stop(-34, -5, z=-1.4, look=(-43, 0), sweep=130)]),
    ("tour_abbe", [stop(-34, -5, z=3.0, look=(-44, -5), sweep=180)]),
    ("tour_sommet", [stop(-34, -5, z=7.1, look=(-44, -5), sweep=150)]),
    ("mur_ouest", [stop(-25, 9, look=(-18, 12), sweep=120), stop(-21, 24, look=(-14, 20), sweep=120), stop(-23, 38, via=True)]),
    ("nef", [stop(-7, 40, look=(25, 29), sweep=120), stop(9, 35, look=(25, 29), sweep=90), stop(18, 33, via=True)]),
    ("croisee", [stop(27, 28, sweep=330)]),
    ("abside", [stop(33, 26.5, look=(37, 25.5), sweep=160)]),
    ("transept_nord", [stop(28, 35.5, look=(36, 32), sweep=180)]),
    ("absidioles_sud", [stop(25, 20, look=(32, 21), sweep=120), stop(26, 15, look=(32, 15.5), sweep=120)]),
    ("cote_est", [stop(42, 26, look=(34, 22), sweep=120), stop(38, 6, look=(25, 8), sweep=140), stop(33, -12, look=(19, -20), sweep=90)]),
    ("tour_defense", [stop(19, -20, look=(29, -20), sweep=100)]),
    ("passage_champs", [stop(23, -5, look=(14, -3), sweep=90), stop(15, -3, look=(23, -5), sweep=90)]),
    ("retour_cloitre", [stop(9, -1, look=(-3, 20), sweep=120)]),
]
LINK_MAX = 45.0
LINK_MAX_RISE = 1.5
TITLE_AT = 0.7
EYE = 1.5
GROUND_FLOOR_TOP = 1.8
CELL = 0.2
MARGIN = 3.0
MIN_TONE = 8
CLEARANCE = 0.3
COMFORT = 1.0
HEIGHT_TOLERANCE = 0.45
FLOOR_HOLES = 3
RAYS = 360
RAY_REACH = 40.0
WALK_SPEED = 0.6
SWEEP_SPEED = np.radians(9.0)
SWEEP_WIDTH = np.radians(160.0)
FULL_SWEEP = np.radians(330.0)
MAX_TURN = np.radians(15.0)
RAMP = 2.0
STEP = 0.1
OFFSETS = [o for o in itertools.product((-1, 0, 1), repeat=3) if o > (0, 0, 0)]


def load_air(path):
    raw = open(path, "rb").read()
    size = int(np.frombuffer(raw, "<u4", 1)[0])
    header = json.loads(raw[4:4 + size])
    start = 4 + (size + 3) // 4 * 4
    return header, np.frombuffer(raw, "<u4", offset=start)


def without_air(points, air):
    header, numbers = air
    voxel, low, shape = header["voxel"], np.array(header["low"]), header["shape"]
    cell = np.floor((points - low) / voxel).astype(np.int64)
    number = cell[:, 0] + cell[:, 1] * shape[0] + cell[:, 2] * shape[0] * shape[1]
    return points[~np.isin(number, numbers)]


def without_masked(points, paths):
    for path in paths:
        points = without_air(points, load_air(path))
    return points


class Grid:
    def __init__(self, points, stations):
        self.low = stations.min(axis=0) - [MARGIN, MARGIN, 2.5]
        high = stations.max(axis=0) + [MARGIN, MARGIN, 3.5]
        self.shape = np.ceil((high - self.low) / CELL).astype(int)
        inside = points[np.all((points >= self.low) & (points < high), axis=1)]
        cell = ((inside - self.low) / CELL).astype(int)
        self.solid = np.zeros(self.shape, bool)
        self.solid[cell[:, 0], cell[:, 1], cell[:, 2]] = True
        self.clearance = ndimage.distance_transform_edt(~self.solid, sampling=CELL)
        # Height above whatever lies below, for each cell.
        self.above = np.full(self.shape, np.inf, np.float32)
        last = np.full(self.shape[:2], -1)
        for z in range(self.shape[2]):
            self.above[:, :, z] = np.where(last >= 0, (z - last) * CELL, np.inf)
            last = np.where(self.solid[:, :, z], z, last)

    def cell_of(self, position):
        return tuple(np.clip(((position - self.low) / CELL).astype(int), 0, self.shape - 1))

    def position_of(self, cell):
        return self.low + (np.asarray(cell) + 0.5) * CELL


def walkable_cells(grid, positions):
    free = grid.clearance >= CLEARANCE
    walk = free & (np.abs(grid.above - EYE) <= HEIGHT_TOLERANCE)
    # Small holes in the floor seen by the laser are no reason to walk around them.
    walk = ndimage.binary_closing(walk, structure=np.ones((3, 3, 1)), iterations=FLOOR_HOLES) & free
    # What lies below a stop may be unseen: let the walk start there, whatever lies below.
    for position in positions:
        x, y, z = grid.cell_of(position)
        box = (slice(max(x - 4, 0), x + 5), slice(max(y - 4, 0), y + 5), slice(max(z - 3, 0), z + 4))
        walk[box] |= free[box]
    return walk


def snap(grid, walk, at, z):
    """The walkable cell closest to a stop chosen on the plan, at the height given."""
    x, y = ((np.asarray(at) - grid.low[:2]) / CELL).astype(int)
    r = 25
    box = (slice(max(x - r, 0), x + r + 1), slice(max(y - r, 0), y + r + 1))
    near = np.argwhere(walk[box]) + [box[0].start, box[1].start, 0]
    heights = grid.low[2] + (near[:, 2] + 0.5) * CELL
    apart = np.linalg.norm((near[:, :2] - [x, y]) * CELL, axis=1)
    return tuple(near[np.argmin(apart + 2 * np.abs(heights - z))])


def walk_graph(grid, walk):
    ids = np.full(grid.shape, -1, np.int32)
    cells = np.argwhere(walk)
    ids[walk] = np.arange(len(cells))
    off = np.nan_to_num(np.abs(grid.above[walk] - EYE), posinf=1.0)
    comfort = 1 + 4 * np.clip(1 - grid.clearance[walk] / COMFORT, 0, 1) ** 2 + off
    rows, cols, costs = [], [], []
    for offset in OFFSETS:
        other = cells + offset
        ok = np.all((other >= 0) & (other < grid.shape), axis=1)
        here, there = np.flatnonzero(ok), ids[tuple(other[ok].T)]
        ok = there >= 0
        here, there = here[ok], there[ok]
        length = CELL * np.linalg.norm(offset)
        rows.append(here)
        cols.append(there)
        costs.append(length * (comfort[here] + comfort[there]) / 2)
    graph = sparse.csr_matrix((np.concatenate(costs), (np.concatenate(rows), np.concatenate(cols))), shape=(len(cells), len(cells)))
    return graph, cells, ids


def free_distances(grid, position):
    """Distance to the first obstacle in each horizontal direction, and the cells seen on the way."""
    angles = np.arange(RAYS) * 2 * np.pi / RAYS
    steps = np.arange(1, int(RAY_REACH / CELL))[:, None] * CELL
    xs = position[0] + steps * np.cos(angles)
    ys = position[1] + steps * np.sin(angles)
    cx = ((xs - grid.low[0]) / CELL).astype(int)
    cy = ((ys - grid.low[1]) / CELL).astype(int)
    cz = int((position[2] - grid.low[2]) / CELL)
    inside = (cx >= 0) & (cx < grid.shape[0]) & (cy >= 0) & (cy < grid.shape[1])
    hit = np.zeros(cx.shape, bool)
    hit[inside] = grid.solid[cx[inside], cy[inside], min(cz, grid.shape[2] - 1)]
    hit |= ~inside
    first = np.where(hit.any(axis=0), hit.argmax(axis=0), len(steps) - 1)
    seen = set()
    for ray in range(RAYS):
        reach = first[ray]
        seen.update((cx[:reach, ray] // 2 + (cy[:reach, ray] // 2) * 100000).tolist())
    level = int(position[2] // 2.5) * 10 ** 10
    return (first + 1) * CELL, {c + level for c in seen}


def path_between(pred, source_row, target):
    path = [target]
    while pred[source_row, path[-1]] >= 0:
        path.append(pred[source_row, path[-1]])
    return path[::-1]


def smooth_path(grid, path):
    """Round the corners of the cell path as long as it stays clear of everything."""
    if len(path) < 5:
        return path
    length = np.linalg.norm(np.diff(path, axis=0), axis=1)
    arc = np.concatenate([[0], np.cumsum(length)])
    even = np.arange(0, arc[-1], 0.05)
    even = np.append(even, arc[-1])
    points = np.column_stack([np.interp(even, arc, path[:, i]) for i in range(3)])
    for sigma in (1.2, 0.8, 0.5, 0.3, 0.15):
        result = ndimage.gaussian_filter1d(points, sigma / 0.05, axis=0, mode="nearest")
        ends = np.minimum(even, even[-1] - even) / (2 * sigma)
        weight = np.clip(ends, 0, 1)[:, None]
        result = points * (1 - weight) + result * weight
        cells = np.clip(((result - grid.low) / CELL).astype(int), 0, grid.shape - 1)
        if grid.clearance[tuple(cells.T)].min() >= CLEARANCE - CELL:
            return result
    return points


def sweep_range(profile, sweep):
    """The stretch of directions showing the most, as start and end angles."""
    area = profile ** 2
    width = int(np.degrees(sweep))
    window = np.convolve(np.concatenate([area, area[:width]]), np.ones(width), "valid")[:RAYS]
    start = int(window.argmax())
    return np.radians(start), np.radians(start + width)


def turn_towards(current, target):
    return current + np.arctan2(np.sin(target - current), np.cos(target - current))


def ceiling_above(grid, position):
    x, y, z = grid.cell_of(position)
    above = np.flatnonzero(grid.solid[x, y, z:])
    return above[0] * CELL if len(above) else 99.0


def timeline(grid, stops, walks):
    """Yaw and position every STEP seconds: a sweep at each stop, then the walk to the next one.

    Each stop gets the frames of the walk leaving it."""
    times_pos, times_yaw = [], []
    if walks:
        start = walks[0][min(20, len(walks[0]) - 1)] - walks[0][0]
        yaw = float(np.arctan2(start[1], start[0]))
    else:
        yaw = 0.0
    for index, here in enumerate(stops):
        position = here["position"]
        if not here["via"]:
            profile, _ = free_distances(grid, position)
            # With nowhere to walk to, look all around instead.
            sweep = np.radians(here["sweep"]) if here["sweep"] else (SWEEP_WIDTH if walks else FULL_SWEEP)
            if here["look"]:
                centre = np.arctan2(here["look"][1] - position[1], here["look"][0] - position[0])
                low, high = centre - sweep / 2, centre + sweep / 2
            else:
                low, high = sweep_range(ndimage.uniform_filter1d(profile, 15, mode="wrap"), sweep)
            low, high = turn_towards(yaw, low), turn_towards(yaw, high)
            begin, end = (low, low + sweep) if abs(low - yaw) <= abs(high - yaw) else (high, high - sweep)
            # A room reached through a fade opens on its view, without turning first through a wall.
            if index == 0 and not walks:
                yaw = begin
            for target in (begin, end):
                frames = max(int(abs(target - yaw) / SWEEP_SPEED / STEP), 1)
                for yaw_now in np.linspace(yaw, target, frames):
                    times_yaw.append(yaw_now)
                    times_pos.append(position)
                yaw = target
        if index == len(walks):
            continue
        walk = walks[index]
        length = np.linalg.norm(np.diff(walk, axis=0), axis=1)
        arc = np.concatenate([[0], np.cumsum(length)])
        total = arc[-1]
        duration = total / WALK_SPEED + RAMP
        frames = max(int(duration / STEP), 2)
        now = np.linspace(0, 1, frames)
        ramp = min(RAMP / duration, 0.45)
        velocity = np.ones(frames)
        # Passing a stop without stopping: no slowing down there.
        if not here["via"]:
            velocity = np.minimum(velocity, now / ramp)
        if not stops[index + 1]["via"]:
            velocity = np.minimum(velocity, (1 - now) / ramp)
        s = np.cumsum(velocity)
        s = (s - s[0]) / (s[-1] - s[0]) * total
        for distance in s:
            at = np.array([np.interp(distance, arc, walk[:, i]) for i in range(3)])
            ahead = np.array([np.interp(distance + 2.5, arc, walk[:, i]) for i in range(3)]) - at
            heading = np.arctan2(ahead[1], ahead[0]) if np.hypot(ahead[0], ahead[1]) > 0.1 else yaw
            times_pos.append(at)
            times_yaw.append(heading)
        # Lean towards the most open side of the way, sampled every few metres.
        block = np.array(times_yaw[-len(s):])
        for chunk in np.array_split(np.arange(len(s)), max(len(s) // 40, 1)):
            middle = times_pos[-len(s) + chunk[len(chunk) // 2]]
            profile, _ = free_distances(grid, middle)
            profile = ndimage.uniform_filter1d(profile, 25, mode="wrap")
            heading = block[chunk[len(chunk) // 2]]
            directions = np.arange(RAYS) * 2 * np.pi / RAYS
            facing = np.cos(np.arctan2(np.sin(directions - heading), np.cos(directions - heading)))
            score = np.where(facing > 0.35, profile * (0.4 + facing), 0)
            lean = directions[int(score.argmax())]
            block[chunk] = heading + 0.8 * np.arctan2(np.sin(lean - heading), np.cos(lean - heading))
        times_yaw[-len(s):] = block.tolist()
        # Headings came wrapped: make the whole walk continuous with what comes before it.
        wrapped = np.unwrap(np.array(times_yaw[-len(s) - 1:]))
        times_yaw[-len(s) - 1:] = wrapped.tolist()
        yaw = wrapped[-1]
        here["walk_frames"] = (len(times_pos) - len(s), len(times_pos))
    positions = np.array(times_pos)
    yaws = ndimage.gaussian_filter1d(np.unwrap(np.array(times_yaw)), 2.0 / STEP, mode="nearest")
    # Never turn fast: limit the rate both ways, so that no turn lags behind, then round the changes off.
    limit = MAX_TURN * STEP
    for order in (range(1, len(yaws)), range(len(yaws) - 2, -1, -1)):
        for i in order:
            previous = yaws[i - 1] if order.step == 1 else yaws[i + 1]
            yaws[i] = np.clip(yaws[i], previous - limit, previous + limit)
    yaws = ndimage.gaussian_filter1d(yaws, 0.8 / STEP, mode="nearest")
    positions = ndimage.gaussian_filter1d(positions, 0.4 / STEP, axis=0, mode="nearest")
    # A slow lift of the gaze, higher under high ceilings.
    ceilings = np.array([ceiling_above(grid, p) for p in positions[::10]])
    lift = np.interp(np.arange(len(positions)), np.arange(len(ceilings)) * 10, np.clip((ceilings - 2.0) * 0.05, 0, 0.14))
    lift = ndimage.gaussian_filter1d(lift, 3.0 / STEP, mode="nearest")
    pitch = lift + 0.05 * np.sin(np.arange(len(positions)) * STEP * 0.3)
    return positions, yaws, pitch


def plan(zones, cache, mask_paths, out_path, image_path=None):
    clouds = []
    for zone in zones:
        pts, tones = zone_points(zone, cache)
        clouds.append(pts[tones >= MIN_TONE])
    everything = without_masked(np.concatenate(clouds), mask_paths)
    del clouds
    anchors = np.array([s["position"] for zone in zones if zone["id"] != "gps" for s in zone["stations"]], float)
    grid = Grid(everything, anchors)
    del everything
    # Stops take the height of the nearest scanner position on the ground floor, unless they say otherwise.
    ground = anchors[anchors[:, 2] < GROUND_FLOOR_TOP]
    for _, stops in ROUTE:
        for s in stops:
            if s["z"] is None:
                s["z"] = float(ground[np.linalg.norm(ground[:, :2] - s["at"], axis=1).argmin(), 2])
    walk = walkable_cells(grid, [np.array([*s["at"], s["z"]]) for _, stops in ROUTE for s in stops])
    graph, cells, ids = walk_graph(grid, walk)
    # Stops, cell by cell, and the way to each from the one before it.
    flat = []
    for place, stops in ROUTE:
        for s in stops:
            cell = snap(grid, walk, s["at"], s["z"])
            flat.append({**s, "place": place, "cell": cell, "id": int(ids[cell]), "position": grid.position_of(cell)})
            print(f"{place:20s} {s['at']} -> {np.round(flat[-1]['position'], 1)}", flush=True)
    chains = [[flat[0]]]
    links = []
    for before, after in zip(flat, flat[1:]):
        _, pred = csgraph.dijkstra(graph, directed=False, indices=before["id"], return_predecessors=True)
        reachable = pred[after["id"]] >= 0 or before["id"] == after["id"]
        path = np.array([grid.position_of(cells[c]) for c in path_between(pred[None], 0, after["id"])]) if reachable else None
        length = np.linalg.norm(np.diff(path, axis=0), axis=1).sum() if reachable else np.inf
        same_place = before["place"] == after["place"]
        rise = abs(before["position"][2] - after["position"][2])
        if reachable and len(path) > 1 and (same_place or (length <= LINK_MAX and rise <= LINK_MAX_RISE)):
            before["walk"] = smooth_path(grid, path)
            chains[-1].append(after)
            print(f"  à pied {before['place']} -> {after['place']}: {length:.1f} m", flush=True)
        else:
            if same_place:
                print(f"  ! coupure dans {before['place']}", flush=True)
            print(f"  fondu {before['place']} -> {after['place']}: {length:.1f} m, dénivelé {rise:.1f}", flush=True)
            chains.append([after])
    out_chains, places = [], []
    for number, chain in enumerate(chains):
        walks = [s["walk"] for s in chain[:-1]]
        positions, yaws, pitch = timeline(grid, chain, walks)
        keys = np.column_stack([positions, yaws, pitch])[::int(1 / STEP)]
        out_chains.append(np.round(keys, 2).tolist())
        check = np.clip(((positions - grid.low) / CELL).astype(int), 0, grid.shape - 1)
        print(f"chaîne {number}: {len(keys)} s, écart mini {grid.clearance[tuple(check.T)].min():.2f} m, "
              f"rotation maxi {np.degrees(np.abs(np.diff(yaws)).max() / STEP):.0f}°/s", flush=True)
        # A place begins partway through the walk leading to it.
        begun = {}
        for before, after in zip(chain, chain[1:]):
            if after["place"] != before["place"] and after["place"] not in begun:
                a, b = before["walk_frames"]
                begun[after["place"]] = int(a + (b - a) * TITLE_AT) // int(1 / STEP)
        begun = {chain[0]["place"]: 0, **begun}
        names = list(begun)
        for name, following in zip(names, names[1:] + [None]):
            places.append({"id": name, "chain": number, "from": begun[name], "to": begun[following] if following else len(keys) - 1})
    with open(out_path, "w") as out:
        json.dump({"chains": out_chains, "places": places}, out, separators=(",", ":"))
    total = sum(len(c) for c in out_chains)
    print(f"total {total // 60} min {total % 60:02d} s, {len(places)} lieux, {len(out_chains)} chaînes")
    if image_path:
        from PIL import Image
        image = np.clip(np.log1p(grid.solid.sum(axis=2)) * 70, 0, 255).astype(np.uint8)
        image = np.stack([image] * 3, axis=-1)
        for keys in out_chains:
            for x, y, z, *_ in keys:
                cx, cy, _ = grid.cell_of(np.array([x, y, z]))
                image[max(cx - 1, 0):cx + 2, max(cy - 1, 0):cy + 2] = (255, 60, 60)
        Image.fromarray(np.flipud(image.transpose(1, 0, 2))).resize((grid.shape[0] * 2, grid.shape[1] * 2)).save(image_path)


if __name__ == "__main__":
    plan(load_manifest(), sys.argv[1], sys.argv[2].split(","), sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
