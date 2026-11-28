#!/usr/bin/env python3
"""
Builds the fonts the server ships (ADR 0220 §1) into a directory the server reads as FONTS_DIR.

    python3 scripts/fonts/build.py scripts/fonts/fonts.lock.json <out-dir>
    python3 scripts/fonts/build.py --lock scripts/fonts/fonts.lock.json   # fills in the SHA-256 of every source file

Every source file is downloaded from the commit the lock pins and checked against its SHA-256 before it is used.
For each family it writes, under <out-dir>/<id>/:

- the license text, as the family ships it;
- web/: WOFF2 files for browsers (a variable family: one per style, all its scripts);
- static/: TrueType instances the server measures text with, draws pictures with and embeds in PDFs (every 100 from
  300 to 800 the family covers, and italic 400 and 700), cut to Latin and Latin Extended;

and <out-dir>/catalog.json, which `packages/engine/src/fonts/library.ts` reads.

A family whose license reserves its name (`"reserved": true` in the lock) is shipped as its authors' own files only:
no instance, subset or conversion of it is made (its authors publish the static and WOFF2 files it needs).

Needs fontTools with WOFF2 support (`pip install "fonttools[woff]"`).
"""

import hashlib
import json
import os
import sys
import urllib.request
from io import BytesIO

STATIC_WEIGHTS = [300, 400, 500, 600, 700, 800]
ITALIC_WEIGHTS = [400, 700]
LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0100-024F,U+0259,U+1E00-1EFF,U+2000-206F,U+2074,U+20A0-20CF,U+2113,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"


def url_of(entry, path):
    if entry["source"] == "google":
        return f"https://raw.githubusercontent.com/google/fonts/{entry['commit']}/{entry['dir']}/{path}"
    return f"https://raw.githubusercontent.com/{entry['repo']}/{entry['commit']}/{path}"


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    if len(data) > 40 * 1024 * 1024:
        raise SystemExit(f"{url}: over 40 MB")
    return data


def sources(entry):
    files = list(entry.get("files", []))
    files += list(entry.get("static", {}).values())
    files += [face["file"] for face in entry.get("web", [])]
    files.append(entry["license"])
    return sorted(set(files))


def lock(path):
    with open(path) as f:
        data = json.load(f)
    for entry in data["fonts"]:
        entry["sha256"] = {}
        for name in sources(entry):
            entry["sha256"][name] = hashlib.sha256(fetch(url_of(entry, name))).hexdigest()
        print(entry["id"], len(entry["sha256"]), "files", file=sys.stderr)
    with open(path, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")


def checked(entry, name):
    data = fetch(url_of(entry, name))
    want = entry.get("sha256", {}).get(name)
    got = hashlib.sha256(data).hexdigest()
    if want != got:
        raise SystemExit(f"{entry['id']}/{name}: SHA-256 {got} isn't the locked {want}")
    return data


def axes_of(font):
    if "fvar" not in font:
        return {}
    return {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in font["fvar"].axes}


def latin_subset(font):
    from fontTools import subset

    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    options.hinting = False
    subsetter = subset.Subsetter(options)
    unicodes = []
    for part in LATIN.split(","):
        part = part.replace("U+", "")
        lo, _, hi = part.partition("-")
        unicodes.extend(range(int(lo, 16), int(hi or lo, 16) + 1))
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)


def save(font, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    font.save(path)


def build_family(entry, out):
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer

    fid = entry["id"]
    root = os.path.join(out, fid)
    os.makedirs(root, exist_ok=True)
    license_name = os.path.basename(entry["license"])
    with open(os.path.join(root, license_name), "wb") as f:
        f.write(checked(entry, entry["license"]))
    record = {"static": {}, "web": [], "license": f"{fid}/{license_name}"}

    if entry.get("reserved"):
        # The authors' own files, byte for byte.
        os.makedirs(os.path.join(root, "static"), exist_ok=True)
        for key, name in entry["static"].items():
            target = f"static/{os.path.basename(name)}"
            with open(os.path.join(root, target), "wb") as f:
                f.write(checked(entry, name))
            record["static"][key] = f"{fid}/{target}"
        for face in entry["web"]:
            target = f"web/{os.path.basename(face['file'])}"
            os.makedirs(os.path.join(root, "web"), exist_ok=True)
            with open(os.path.join(root, target), "wb") as f:
                f.write(checked(entry, face["file"]))
            record["web"].append({"file": f"{fid}/{target}", "weight": face["weight"], "style": face["style"]})
        return record

    for name in entry["files"]:
        data = checked(entry, name)
        italic = "Italic" in name or name.endswith("-It.ttf")
        style = "italic" if italic else "normal"
        font = TTFont(BytesIO(data))
        axes = axes_of(font)
        stem = f"{fid}{'-italic' if italic else ''}"
        # Browsers: the whole file as WOFF2 (every script it has).
        web = TTFont(BytesIO(data))
        web.flavor = "woff2"
        save(web, os.path.join(root, "web", f"{stem}.woff2"))
        if "wght" in axes:
            lo, _, hi = axes["wght"]
            weight = f"{int(lo)} {int(hi)}"
        else:
            weight = str(font["OS/2"].usWeightClass)
        record["web"].append({"file": f"{fid}/web/{stem}.woff2", "weight": weight, "style": style})
        # The server: static instances, Latin only.
        if "wght" in axes:
            lo, _, hi = axes["wght"]
            wanted = ITALIC_WEIGHTS if italic else STATIC_WEIGHTS
            for w in [w for w in wanted if lo <= w <= hi]:
                pins = {tag: (w if tag == "wght" else default) for tag, (_, default, _) in axes.items()}
                inst = instancer.instantiateVariableFont(TTFont(BytesIO(data)), pins, updateFontNames=False)
                latin_subset(inst)
                key = f"{w}{'i' if italic else ''}"
                save(inst, os.path.join(root, "static", f"{fid}-{key}.ttf"))
                record["static"][key] = f"{fid}/static/{fid}-{key}.ttf"
        else:
            w = font["OS/2"].usWeightClass
            if (italic and w in ITALIC_WEIGHTS) or (not italic and 300 <= w <= 800) or w == 400:
                static = TTFont(BytesIO(data))
                if "fvar" in static:
                    static = instancer.instantiateVariableFont(static, {t: d for t, (_, d, _) in axes.items()})
                latin_subset(static)
                key = f"{w}{'i' if italic else ''}"
                save(static, os.path.join(root, "static", f"{fid}-{key}.ttf"))
                record["static"][key] = f"{fid}/static/{fid}-{key}.ttf"
    return record


def build(lock_path, out):
    with open(lock_path) as f:
        data = json.load(f)
    os.makedirs(out, exist_ok=True)
    catalog = {"fonts": {}}
    # One process per family: instancing is the slow part, and families don't share anything.
    from concurrent.futures import ProcessPoolExecutor

    with ProcessPoolExecutor() as pool:
        futures = {entry["id"]: pool.submit(build_family, entry, out) for entry in data["fonts"]}
        for fid, future in futures.items():
            catalog["fonts"][fid] = future.result()
            print(fid, "ok", file=sys.stderr)
    with open(os.path.join(out, "catalog.json"), "w") as f:
        json.dump(catalog, f, indent=1)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--lock":
        lock(sys.argv[2])
    elif len(sys.argv) == 3:
        build(sys.argv[1], sys.argv[2])
    else:
        raise SystemExit(__doc__)
