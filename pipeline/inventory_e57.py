#!/usr/bin/env python3
"""List every E57 on an rclone remote from its header and XML section, without reading points.

An E57 starts with a 48-byte header pointing to an XML description near the end of the file,
so two partial reads are enough. Writes one JSON object per file. Standard library only.
"""
import json
import math
import re
import struct
import subprocess
import sys
import threading
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

REMOTE, OUTPUT = sys.argv[1], sys.argv[2]
WORKERS = 8


def rclone(*args):
    return subprocess.run(["rclone", *args], check=True, capture_output=True, timeout=300).stdout


def read(path, offset, count):
    return rclone("cat", "--offset", str(offset), "--count", str(count), f"{REMOTE}{path}")


def strip_page_crc(raw, offset, page):
    parts, position, i = [], offset, 0
    while i < len(raw):
        data_end = (position // page + 1) * page - 4
        n = data_end - position
        parts.append(raw[i : i + n])
        i += n + 4
        position += n + 4
    return b"".join(parts)


def local(tag):
    return tag.split("}")[-1]


def child(node, name):
    if node is None:
        return None
    for item in node:
        if local(item.tag) == name:
            return item
    return None


def text(node, name):
    found = child(node, name)
    return found.text.strip() if found is not None and found.text else None


def number(node, name):
    value = text(node, name)
    return float(value) if value is not None else None


def inspect(entry):
    path = entry["Path"]
    result = {"path": path, "bytes": entry["Size"]}
    try:
        head = read(path, 0, 48)
        if head[:8] != b"ASTM-E57":
            raise ValueError("not an E57 file")
        length, xml_offset, xml_length, page = struct.unpack("<QQQQ", head[16:48])
        physical = math.ceil(xml_length * page / (page - 4)) + page
        raw = read(path, xml_offset, min(physical, length - xml_offset))
        xml = strip_page_crc(raw, xml_offset, page)[:xml_length]
        root = ET.fromstring(xml)
        scans = list(child(root, "data3D") if child(root, "data3D") is not None else [])
        images = list(child(root, "images2D") if child(root, "images2D") is not None else [])
        result.update(scans=len(scans), images=len(images))
        if scans:
            scan = scans[0]
            points = child(scan, "points")
            prototype = child(points, "prototype")
            result["fields"] = [local(f.tag) for f in prototype] if prototype is not None else []
            result["points"] = int(points.attrib.get("recordCount", 0))
            result["colour"] = "colorRed" in result["fields"]
            result["sensor"] = text(scan, "sensorModel") or text(scan, "sensorVendor")
            result["software"] = text(scan, "sensorSoftwareVersion")
            result["acquired"] = text(child(scan, "acquisitionStart"), "dateTimeValue")
            pose = child(scan, "pose")
            translation = child(pose, "translation")
            if translation is not None:
                result["position"] = [number(translation, axis) for axis in "xyz"]
    except Exception as error:
        result["error"] = re.sub(r"\s+", " ", repr(error))[:300]
    return result


entries = [
    e
    for e in json.loads(rclone("lsjson", "-R", "--files-only", REMOTE))
    if e["Path"].lower().endswith(".e57")
]
print(f"{len(entries)} files", flush=True)
lock = threading.Lock()
done = 0
with open(OUTPUT, "w") as out, ThreadPoolExecutor(WORKERS) as pool:
    for row in pool.map(inspect, entries):
        with lock:
            out.write(json.dumps(row) + "\n")
            out.flush()
            done += 1
            if done % 50 == 0:
                print(done, flush=True)
print("done", flush=True)
