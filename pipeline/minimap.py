"""Draw the small isometric model of the abbey shown beside the view, from the coarse points.

Inside the outlines of the buildings, a cell whose points rise through most of a slice is a wall, raised to the
height the scan found. Roofs come from the highest points too, drawn in tiles and see-through so that the walls
and the route stay readable. The hedges that draw the church are added.
The picture is seen from the south-west, along the axes of the buildings; minimap.json gives the projection.
"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from coarse_points import load_manifest, zone_points
from plan_tour import MIN_TONE, without_masked

CELL = 0.25
BIN = 0.2
# Between the furniture and the first ceilings; the church stands higher, and has no ceilings left.
SLICE = (-1.2, 0.8)
CHURCH_SLICE = (1.0, 2.4)
WALL_SHARE = 0.8
BASE = -2.0
CUT = 1.2
ROOF_MIN = 2.5
ROOF_ALPHA = 0.74
AXIS_ANGLE = np.radians(-19.0)
WIDTH = 880
PAD = 18
SUPER = 2
SITE = [(-44, -13), (-22, -18), (16, -30), (26, -32), (46, -22), (52, 25), (47, 45), (27, 50), (-25, 54), (-30, 46), (-46, 8)]
# Where walls are looked for, leaving trees and sheds out.
BUILT = [
    [(-26, -8), (-16, -11.5), (0, -15), (15, -18.5), (23, -21), (31, 8), (37, 12), (43, 18), (42, 40), (31, 43), (29, 35), (22, 27.5), (-4, 36.5), (-14, 38.5), (-20, 37)],
    [(-43, -5), (-37, -13), (-29, -12), (-26, -5), (-29, 3), (-37, 3)],
    [(11, -21), (18, -27), (25, -25), (26, -19), (20, -15)],
]
CHURCH = [(-20, 37), (-14, 34), (22, 24), (26, 12), (31, 8), (37, 12), (43, 18), (42, 40), (31, 43), (29, 35)]
ROOFED = [
    [(17, 15), (29, 11), (22, -20), (0, -15), (2, -5), (11, -3)],
    [(-17, 36), (-5, 33), (-9, 26), (-15, 3), (-13, 1), (-16, -10), (-25, -7), (-23, 2)],
]
OPEN_GROUND = [[(0, 0), (12, 0), (14, 19), (0, 24)]]
ROOFED_TOWERS = [((-34.5, -5.2), 6.2)]
# What still stands of the church, such as the half-domes of the side chapels.
STANDING_MIN = 3.5
HEDGES = [[(4.5, 42.5), (23.5, 36), (24.5, 38), (27, 48), (41, 45), (46, 41), (49, 28), (47, 16), (42.5, 2), (37, -20)],
          [(-21, 49), (-11, 46)], [(-6, 45.5), (4.5, 42.5)]]
MIN_PIECE = 30
HEDGE_TOP_Z = -0.6
WALL_TOP, WALL_LEFT, WALL_RIGHT = (236, 226, 205), (172, 155, 128), (135, 118, 95)
HEDGE_TOP, HEDGE_LEFT, HEDGE_RIGHT = (112, 138, 92), (84, 108, 70), (68, 90, 58)
FLOOR = (104, 100, 90)
TILE = np.array((188, 82, 54))
SUN = np.array((-0.45, -0.5, 0.74))
GROUND, GROUND_EDGE = (66, 74, 56), (48, 54, 42)


def inside(xs, ys, outline):
    image = Image.new("1", (len(ys), len(xs)))
    ImageDraw.Draw(image).polygon([((y - ys[0]) / CELL, (x - xs[0]) / CELL) for x, y in outline], fill=1)
    return np.array(image)


def main(cache, mask_paths, out_png, out_json):
    zones = load_manifest()
    clouds = []
    for zone in zones:
        points, tones = zone_points(zone, cache)
        clouds.append(points[tones >= MIN_TONE])
    points = without_masked(np.concatenate(clouds), mask_paths)
    low = np.array([-50.0, -40.0])
    shape = (int(105 / CELL), int(100 / CELL))
    cell = ((points[:, :2] - low) / CELL).astype(int)
    ok = np.all((cell >= 0) & (cell < shape), axis=1)
    cell, heights = cell[ok], points[ok, 2]
    def share_in(slice_):
        bins = int(round((slice_[1] - slice_[0]) / BIN))
        occupied = np.zeros((*shape, bins), bool)
        kept = (heights >= slice_[0]) & (heights < slice_[1])
        occupied[cell[kept, 0], cell[kept, 1], ((heights[kept] - slice_[0]) / BIN).astype(int)] = True
        return occupied.mean(axis=2)

    top = np.full(shape, BASE)
    np.maximum.at(top, (cell[:, 0], cell[:, 1]), heights)
    xs = low[0] + np.arange(shape[0]) * CELL
    ys = low[1] + np.arange(shape[1]) * CELL
    built = np.any([inside(xs, ys, outline) for outline in BUILT], axis=0)
    built &= ~np.any([inside(xs, ys, outline) for outline in OPEN_GROUND], axis=0)
    church = inside(xs, ys, CHURCH)
    wall = (np.where(church, share_in(CHURCH_SLICE), share_in(SLICE)) >= WALL_SHARE) & built
    wall = ndimage.binary_closing(wall, iterations=1)
    labels, count = ndimage.label(wall, structure=np.ones((3, 3)))
    sizes = ndimage.sum(wall, labels, range(1, count + 1))
    buildings = np.isin(labels, np.flatnonzero(sizes >= MIN_PIECE) + 1)
    buildings = ndimage.binary_dilation(buildings)
    hedge = np.zeros(shape, bool)
    canvas = Image.new("1", (shape[1], shape[0]))
    for line in HEDGES:
        ImageDraw.Draw(canvas).line([((y - low[1]) / CELL, (x - low[0]) / CELL) for x, y in line], fill=1, width=int(1.6 / CELL))
    hedge = np.array(canvas) & ~buildings

    xx, yy = np.meshgrid(xs, ys, indexing="ij")
    height_map = ndimage.median_filter(top, size=5)
    buildings |= church & built & (height_map > STANDING_MIN)
    roof = np.any([inside(xs, ys, outline) for outline in ROOFED], axis=0)
    for (cx, cy), radius in ROOFED_TOWERS:
        roof |= np.hypot(xx - cx, yy - cy) < radius
    roof &= height_map > ROOF_MIN
    roof = ndimage.binary_fill_holes(ndimage.binary_closing(roof, iterations=2))
    roof_height = ndimage.gaussian_filter(ndimage.median_filter(ndimage.grey_closing(height_map, size=7), size=11), 1.5)
    column = np.maximum(height_map, CUT)
    # Under a roof, walls stop where the slope begins.
    lowest = ndimage.median_filter(ndimage.minimum_filter(np.where(roof, roof_height, 1e3), size=9), size=9)
    column = np.where(roof, np.minimum(column, lowest), column)
    slope_x, slope_y = np.gradient(roof_height, CELL)
    normal = np.stack([-slope_x, -slope_y, np.ones(shape)], axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    roof_light = np.clip(0.62 + 0.5 * (normal @ SUN), 0.45, 1.1)
    # Along the axes of the buildings: u towards the east end, v towards the north.
    u_axis = np.array([np.cos(AXIS_ANGLE), np.sin(AXIS_ANGLE)])
    v_axis = np.array([-np.sin(AXIS_ANGLE), np.cos(AXIS_ANGLE)])
    u = lambda x, y: x * u_axis[0] + y * u_axis[1]
    v = lambda x, y: x * v_axis[0] + y * v_axis[1]
    sx = lambda x, y: (u(x, y) - v(x, y)) * np.cos(np.radians(30))
    sy = lambda x, y, z: -(u(x, y) + v(x, y)) * 0.5 - z
    corners = np.array(SITE, float)
    left, right = sx(corners[:, 0], corners[:, 1]).min(), sx(corners[:, 0], corners[:, 1]).max()
    scale = (WIDTH - 2 * PAD) / (right - left)
    high = min(sy(corners[:, 0], corners[:, 1], 0).min(), sy(xx[roof | buildings], yy[roof | buildings], np.maximum(column, np.where(roof, roof_height, column))[roof | buildings]).min())
    bottom = sy(corners[:, 0], corners[:, 1], 0).max()
    height = int((bottom - high) * scale + 2 * PAD)
    project = lambda x, y, z=0.0: ((sx(x, y) - left) * scale + PAD, (sy(x, y, z) - high) * scale + PAD)

    big = SUPER
    image = Image.new("RGBA", (WIDTH * big, height * big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    scaled = lambda points: [(px * big, py * big) for px, py in points]
    draw.polygon(scaled([project(x, y, BASE - 0.6) for x, y in SITE]), fill=GROUND_EDGE)
    draw.polygon(scaled([project(x, y, BASE) for x, y in SITE]), fill=GROUND)
    for outline in ROOFED:
        draw.polygon(scaled([project(x, y, BASE) for x, y in outline]), fill=FLOOR)
    du, dv = u_axis * CELL, v_axis * CELL
    order = np.argwhere(buildings | hedge)
    order = order[np.argsort(-(u(xs[order[:, 0]], ys[order[:, 1]]) + v(xs[order[:, 0]], ys[order[:, 1]])))]
    half = CELL / 2
    for i, j in order:
        x, y = xs[i] + half, ys[j] + half
        is_wall = buildings[i, j]
        z = column[i, j] if is_wall else HEDGE_TOP_Z
        tops, lefts, rights = (WALL_TOP, WALL_LEFT, WALL_RIGHT) if is_wall else (HEDGE_TOP, HEDGE_LEFT, HEDGE_RIGHT)
        a = (x - du[0] / 2 - dv[0] / 2, y - du[1] / 2 - dv[1] / 2)
        b = (a[0] + du[0], a[1] + du[1])
        d = (a[0] + dv[0], a[1] + dv[1])
        c = (b[0] + dv[0], b[1] + dv[1])
        # Seen from the south-west: the faces towards -u and -v show.
        draw.polygon(scaled([project(*a, BASE), project(*d, BASE), project(*d, z), project(*a, z)]), fill=lefts)
        draw.polygon(scaled([project(*a, BASE), project(*b, BASE), project(*b, z), project(*a, z)]), fill=rights)
        draw.polygon(scaled([project(*p, z) for p in (a, b, c, d)]), fill=tops)
    # Drawn apart then laid over the rest, so that the see-through tiles do not add up where they overlap.
    tiles = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(tiles)
    lowest_roof = ndimage.minimum_filter(np.where(roof, roof_height, np.inf), size=3)
    order = np.argwhere(roof)
    order = order[np.argsort(-(u(xs[order[:, 0]], ys[order[:, 1]]) + v(xs[order[:, 0]], ys[order[:, 1]])))]
    for i, j in order:
        x, y = xs[i] + half, ys[j] + half
        z, foot = roof_height[i, j], min(lowest_roof[i, j], roof_height[i, j] - 0.3)
        a = (x - du[0] / 2 - dv[0] / 2, y - du[1] / 2 - dv[1] / 2)
        b = (a[0] + du[0], a[1] + du[1])
        d = (a[0] + dv[0], a[1] + dv[1])
        c = (b[0] + dv[0], b[1] + dv[1])
        draw.polygon(scaled([project(*a, foot), project(*d, foot), project(*d, z), project(*a, z)]), fill=tuple((TILE * 0.72).astype(int)) + (255,))
        draw.polygon(scaled([project(*a, foot), project(*b, foot), project(*b, z), project(*a, z)]), fill=tuple((TILE * 0.6).astype(int)) + (255,))
        draw.polygon(scaled([project(*p, z) for p in (a, b, c, d)]), fill=tuple(np.clip(TILE * roof_light[i, j], 0, 255).astype(int)) + (255,))
    tiles.putalpha(tiles.getchannel("A").point(lambda alpha: int(alpha * ROOF_ALPHA)))
    image = Image.alpha_composite(image, tiles)
    image = image.resize((WIDTH, height), Image.LANCZOS)
    image.quantize(colors=200, method=Image.Quantize.FASTOCTREE).save(out_png, optimize=True)
    with open(out_json, "w") as out:
        json.dump({"width": WIDTH, "height": height, "scale": round(scale, 4), "left": round(float(left), 3), "high": round(float(high), 3),
                   "pad": PAD, "axis": round(float(AXIS_ANGLE), 4)}, out)
    print(WIDTH, height, "échelle", scale, "murs", int(buildings.sum()), "toits", int(roof.sum()), "haie", int(hedge.sum()))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2].split(","), sys.argv[3], sys.argv[4])
