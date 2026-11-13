"""LeadHunter installer — build-time manifest generator.

Walks the staged app payload and writes manifest.json:
    {"version": "<version>", "files": {"<relative/path>": "<sha256>", ...}}

The setup helper (installer/setup-helper.ps1) uses this manifest on the
target PC to update in place: only files whose hash changed are copied,
files that vanished from the manifest are deleted, and everything else
is left untouched.

Deliberately EXCLUDED from the manifest (never hash-diffed, never
deleted by an update):
  - agent/leadhunter.db and public/seed.json — seed data. The setup
    helper copies them only when the target has no copy yet, and never
    overwrites them. If they were in the manifest, an update would
    replace the partner's live database with the seed.
  - agent/profiles/, agent/.venv/, node_modules/ — runtime state, not
    payload. They are never part of the payload at all.
  - __pycache__/, *.pyc, agent/*.png — build junk / debug screenshots.
  - manifest.json itself — it cannot hash itself.

Usage (run on the Windows build runner, after the payload is staged):
    python installer/manifest-gen.py <payload-dir> <version> <output-path>
"""

import hashlib
import json
import os
import sys

# Directories never walked (anywhere in the tree).
EXCLUDE_DIRS = {
    "__pycache__",
    ".git",
    ".venv",
    ".pytest_cache",
    "node_modules",
    "profiles",
    ".payload-new",
}

# Exact relative paths (forward slashes) never listed.
EXCLUDE_FILES = {
    "agent/leadhunter.db",
    "public/seed.json",
    "manifest.json",
}

# File extensions never listed, anywhere in the tree.
EXCLUDE_EXTS = {".pyc"}


def build_manifest(payload_dir: str, version: str) -> dict:
    files: dict[str, str] = {}
    for root, dirs, filenames in os.walk(payload_dir):
        # Prune excluded directories before descending.
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
        for name in sorted(filenames):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, payload_dir).replace(os.sep, "/")
            if rel in EXCLUDE_FILES:
                continue
            if os.path.splitext(name)[1].lower() in EXCLUDE_EXTS:
                continue
            # Debug screenshots live only under agent/ — public/ images
            # are real app assets and stay in the payload.
            if rel.startswith("agent/") and name.lower().endswith(".png"):
                continue
            with open(full, "rb") as fh:
                files[rel] = hashlib.sha256(fh.read()).hexdigest()
    return {"version": version, "files": files}


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(
            "usage: manifest-gen.py <payload-dir> <version> <output-path>",
            file=sys.stderr,
        )
        return 2
    payload_dir, version, output_path = argv[1], argv[2], argv[3]
    if not os.path.isdir(payload_dir):
        print(f"payload dir not found: {payload_dir}", file=sys.stderr)
        return 2
    manifest = build_manifest(payload_dir, version)
    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(f"manifest: {len(manifest['files'])} files, version {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
