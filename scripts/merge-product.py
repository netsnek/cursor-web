#!/usr/bin/env python3
"""Merge VS Code's product.json with Cursor's product.json overlay.

Deep merge where overlay values win. Arrays are replaced, not concatenated.

Usage: merge-product.py <vscode-product.json> <cursor-product.json> <output.json>
"""

import json
import sys


def deep_merge(base, overlay):
    """Deep merge overlay into base. Arrays are replaced, dicts are recursed."""
    result = dict(base)
    for key, value in overlay.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def main():
    if len(sys.argv) != 4:
        print(f"Usage: {sys.argv[0]} <vscode-product.json> <cursor-product.json> <output.json>",
              file=sys.stderr)
        sys.exit(1)

    vscode_path, cursor_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]

    with open(vscode_path, "r") as f:
        base = json.load(f)

    with open(cursor_path, "r") as f:
        overlay = json.load(f)

    merged = deep_merge(base, overlay)

    with open(output_path, "w") as f:
        json.dump(merged, f, indent="\t", ensure_ascii=False)
        f.write("\n")

    print(f"Merged product.json written to {output_path}")


if __name__ == "__main__":
    main()
