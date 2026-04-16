#!/usr/bin/env python3
"""Convert .plain.html files to DA (Document Authoring) format.

DA expects the same HTML structure but minified (no extra whitespace)
and with simplified <picture> elements (no width/height on <img>).

Usage: python3 plain-to-da.py <file.plain.html>
"""

import re
import sys


def convert(html):
    # Remove width and height attributes from img tags
    html = re.sub(r'\s+width="[^"]*"', '', html)
    html = re.sub(r'\s+height="[^"]*"', '', html)

    # Collapse whitespace between tags (minify)
    html = re.sub(r'>\s+<', '><', html)

    # Remove leading/trailing whitespace per line, then join
    lines = [line.strip() for line in html.splitlines() if line.strip()]
    html = ''.join(lines)

    # Remove HTML comments
    html = re.sub(r'<!--.*?-->', '', html)

    return html


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: plain-to-da.py <file>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], 'r') as f:
        print(convert(f.read()))
