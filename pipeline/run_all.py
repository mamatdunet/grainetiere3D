#!/usr/bin/env python3
"""Convert every zone of the abbey inside one Vercel Sandbox, with a spending guard.

Zones with a report_<zone>.json are finished and skipped, so the script can be restarted.
A zone that fails is cleared and tried again alone once the others are done.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

CPU_RATE = 0.128  # $ per vCPU-hour of active CPU
MEMORY_RATE = 0.0212 * 16  # $ per hour for 16 GB provisioned
UPLOAD_RATE = 0.15  # $ per GB sent out of the sandbox
SAFETY = 1.3


def zone_of(path):
    import re
    name = re.sub(r"_?\d+\.e57$", "", path.split("/")[-1], flags=re.I).lower()
    return name.removeprefix("ag_")


def busy_cpu_hours():
    fields = open("/proc/stat").readline().split()[1:]
    values = list(map(int, fields))
    return (sum(values[:8]) - values[3] - values[4]) / os.sysconf("SC_CLK_TCK") / 3600


def spent(started, cpu_start):
    uploaded = sum(json.loads(p.read_text()).get("gzipGB", 0) for p in Path(".").glob("report_*.json"))
    hours = (time.time() - started) / 3600
    cost = (busy_cpu_hours() - cpu_start) * CPU_RATE + hours * MEMORY_RATE + uploaded * UPLOAD_RATE
    return cost * SAFETY


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def start(zone, inventory):
    shutil.rmtree(Path("work_zone") / zone, ignore_errors=True)
    logfile = open(f"zone_{zone}.log", "a")
    log("start", zone)
    return subprocess.Popen(
        [sys.executable, "convert_zone.py", zone, "--inventory", inventory],
        stdout=logfile, stderr=subprocess.STDOUT,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", default="inventory.jsonl")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--budget", type=float, default=30.0, help="stop launching zones above this estimate")
    args = parser.parse_args()

    bytes_by_zone = {}
    for line in open(args.inventory):
        record = json.loads(line)
        zone = zone_of(record["path"])
        bytes_by_zone[zone] = bytes_by_zone.get(zone, 0) + record["bytes"]
    todo = [z for z in sorted(bytes_by_zone, key=bytes_by_zone.get) if not Path(f"report_{z}.json").exists()]
    started, cpu_start = time.time(), busy_cpu_hours()
    log(f"{len(todo)} zones to convert")

    retry = []
    for queue, workers in ((todo, args.workers), (retry, 1)):
        running = {}
        while queue or running:
            cost = spent(started, cpu_start)
            if queue and len(running) < workers:
                if cost >= args.budget:
                    log(f"BUDGET reached ({cost:.2f} $), not starting: {queue}")
                    queue.clear()
                    continue
                zone = queue.pop(0)
                running[zone] = start(zone, args.inventory)
                continue
            time.sleep(10)
            for zone, process in list(running.items()):
                code = process.poll()
                if code is None:
                    continue
                del running[zone]
                done = Path(f"report_{zone}.json").exists()
                log(f"end {zone} code {code} {'OK' if done else 'FAILED'} estimate {cost:.2f} $")
                if not done and queue is todo:
                    retry.append(zone)
    missing = [z for z in bytes_by_zone if not Path(f"report_{z}.json").exists()]
    log(f"ALLDONE estimate {spent(started, cpu_start):.2f} $ hours {(time.time() - started) / 3600:.2f} missing {missing}")


if __name__ == "__main__":
    main()
