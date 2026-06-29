#!/usr/bin/env python3
"""Generate Arco-branded intro and outro slides (1920x1080)."""
from PIL import Image
import os

W, H = 1920, 1080
CREAM = (245, 240, 232)      # #F5F0E8
COPPER = (181, 101, 29)      # #B5651D
INK = (28, 43, 53)           # #1C2B35  (Arco text)
MUTED = (92, 107, 115)       # #5C6B73

HERE = os.path.dirname(os.path.abspath(__file__))
# Canonical Arco logo lives in the repo's icons/ dir; fall back to a local copy.
REPO_LOGO = os.path.normpath(os.path.join(HERE, "..", "..", "..", "icons", "arco-logo.png"))
LOGO = REPO_LOGO if os.path.exists(REPO_LOGO) else os.path.join(HERE, "arco-logo.png")


def font(size, bold=False):
    from PIL import ImageFont
    # Helvetica.ttc: index 0 regular, 1 bold (varies); fall back gracefully
    path = "/System/Library/Fonts/Helvetica.ttc"
    try:
        return ImageFont.truetype(path, size, index=1 if bold else 0)
    except Exception:
        return ImageFont.truetype(path, size)


def center_text(draw, text, y, fnt, fill, w=W):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text(((w - tw) / 2, y), text, font=fnt, fill=fill)
    return th


def make_intro():
    from PIL import ImageDraw
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)

    # Logo (coffee bean + wordmark) centered above the title
    logo = Image.open(LOGO).convert("RGBA")
    # trim to a reasonable width
    target_w = 520
    ratio = target_w / logo.width
    logo = logo.resize((target_w, int(logo.height * ratio)), Image.LANCZOS)
    img.paste(logo, ((W - logo.width) // 2, 250), logo)

    # Title + subtitle
    center_text(d, "Arco on Google TV", 560, font(86, bold=True), INK)
    center_text(d, "Your AI coffee advisor, on the biggest screen in the house",
                700, font(40), MUTED)

    # Copper accent rule
    d.rectangle([(W // 2 - 60, 678), (W // 2 + 60, 684)], fill=COPPER)

    img.save(os.path.join(HERE, "images", "intro.png"))
    print("intro.png written")


def make_outro():
    from PIL import ImageDraw
    img = Image.new("RGB", (W, H), INK)   # dark ink background for outro
    d = ImageDraw.Draw(img)

    # Logo on dark: paste as-is (logo has its own colors); place centered-high
    logo = Image.open(LOGO).convert("RGBA")
    target_w = 560
    ratio = target_w / logo.width
    logo = logo.resize((target_w, int(logo.height * ratio)), Image.LANCZOS)
    # white plate behind logo so the dark wordmark reads on dark bg
    plate_pad = 60
    plate = Image.new("RGBA",
                      (logo.width + plate_pad * 2, logo.height + plate_pad * 2),
                      (245, 240, 232, 255))
    px = (W - plate.width) // 2
    py = 330
    img.paste(plate, (px, py), plate)
    img.paste(logo, (px + plate_pad, py + plate_pad), logo)

    center_text(d, "Turning the living room into a point of sale.",
                py + plate.height + 70, font(44, bold=True), CREAM)
    center_text(d, "Adobe Experience Manager",
                py + plate.height + 150, font(34), (168, 162, 153))

    img.save(os.path.join(HERE, "images", "outro.png"))
    print("outro.png written")


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "images"), exist_ok=True)
    make_intro()
    make_outro()
