# Composite one distinct 3D NFT card image per Genesis generation.
#
# The art is a 3D-rendered background (nft/card-bg-3d.png, generated from
# Isaiah's example image: dark, glowing blue-cyan, figures evolving and
# running upward along a bright arrow). The per-generation identity is
# composited on top with PIL, so every card is crisp and consistent:
#   - its own hue, subtitle and glow (same identity as the old SVG cards),
#   - one concentric ring per generation (gen 0 gets 1 ring, gen 9 gets 10),
#   - a row of pips: filled dots = generation number.
# Cards are plain JPEGs — a picture of 3D art, not a 3D model file — so
# every wallet displays them. Served from the website
# (https://genesis-roan-eta.vercel.app/nft/gen-N.jpg) and referenced as
# the `media` URL when minting. Gen 10+ uses the fallback card gen-x.jpg.
# Existing tokens keep their old media: token metadata on the shared
# contract is immutable, so this only applies to new mints.
# This script supersedes scripts/gen-nft-cards.js (flat SVG cards).
#
# Usage: python3 scripts/gen-nft-cards-3d.py
import base64
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'nft')
BG = os.path.join(OUT, 'card-bg-3d.png')
W, H = 768, 1024
FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

GENS = [
    {'n': 0, 'label': '0', 'hue': '#d4a017', 'sub': 'FOUNDER'},
    {'n': 1, 'label': '1', 'hue': '#3ddc84', 'sub': 'FIRSTBORN'},
    {'n': 2, 'label': '2', 'hue': '#4f8ef7', 'sub': 'SECOND LINE'},
    {'n': 3, 'label': '3', 'hue': '#a06bff', 'sub': 'THIRD LINE'},
    {'n': 4, 'label': '4', 'hue': '#ff5a5a', 'sub': 'FOURTH LINE'},
    {'n': 5, 'label': '5', 'hue': '#2dd4bf', 'sub': 'FIFTH LINE'},
    {'n': 6, 'label': '6', 'hue': '#ff8c42', 'sub': 'SIXTH LINE'},
    {'n': 7, 'label': '7', 'hue': '#ff6fb5', 'sub': 'SEVENTH LINE'},
    {'n': 8, 'label': '8', 'hue': '#a3e635', 'sub': 'EIGHTH LINE'},
    {'n': 9, 'label': '9', 'hue': '#818cf8', 'sub': 'NINTH LINE'},
]
FALLBACK = {'n': 10, 'label': 'X', 'hue': '#9aa5b1', 'sub': 'BEYOND THE NINTH LINE'}

LIGHT = '#f5f0dc'
MUTED = '#9aa5b1'
DARK = '#0b1020'


def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def card(bg, g):
    hue = hexrgb(g['hue'])
    n = g['n']
    img = bg.copy()
    # Subtle hue wash over the whole card: each generation has its own
    # colour mood without muddying the blue 3D art.
    wash = Image.new('RGBA', img.size, hue + (18,))
    img = Image.alpha_composite(img.convert('RGBA'), wash).convert('RGB')
    d = ImageDraw.Draw(img, 'RGBA')
    # Glow behind the number, in the generation hue.
    glow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([384 - 260, 430 - 260, 384 + 260, 430 + 260], fill=hue + (70,))
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    img = Image.alpha_composite(img.convert('RGBA'), glow).convert('RGB')
    d = ImageDraw.Draw(img, 'RGBA')
    # Frame.
    d.rounded_rectangle([18, 18, W - 18, H - 18], radius=36, outline=hue + (140,), width=3)
    # Header. (No "NEAR TESTNET" on the right: the robot head occupies
    # the top-right corner and the text collided with it.)
    f_head = ImageFont.truetype(FONT_BOLD, 34)
    d.text((52, 58), '\u25c6 GENESIS', font=f_head, fill=LIGHT)
    d.line([52, 108, 716, 108], fill=hue + (130,), width=2)
    # Rings: one per generation (gen 0 gets 1, gen 9 gets 10).
    cx, cy = 384, 430
    for i in range(n + 1):
        r = 205 - i * 21
        if r < 16:
            break
        alpha = max(40, int(140 - i * 10))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=hue + (alpha,), width=3)
    # Big generation number.
    f_num = ImageFont.truetype(FONT_BOLD, 210)
    d.text((cx, cy), g['label'], font=f_num, fill=hue, anchor='mm',
           stroke_width=3, stroke_fill=DARK)
    # Generation + subtitle.
    f_gen = ImageFont.truetype(FONT_BOLD, 44)
    d.text((384, 560), 'GEN ' + g['label'], font=f_gen, fill=LIGHT, anchor='ma')
    f_sub = ImageFont.truetype(FONT, 30)
    d.text((384, 612), g['sub'], font=f_sub, fill=MUTED, anchor='ma')
    # Bottom band so the pips and footer read over the bright artwork.
    band = Image.new('RGBA', img.size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    for y in range(H - 170, H):
        a = int(150 * (y - (H - 170)) / 170)
        bd.line([0, y, W, y], fill=(5, 8, 16, a))
    img = Image.alpha_composite(img.convert('RGBA'), band).convert('RGB')
    d = ImageDraw.Draw(img, 'RGBA')
    # Pips: filled dots = generation number. They sit just under the
    # header, in the clean dark space — the bottom of the card is busy
    # with the running figures, and the dots collided with them there.
    py = 152
    for i in range(10):
        x = 132 + i * 56
        if i < n:
            d.ellipse([x - 11, py - 11, x + 11, py + 11], fill=hue)
        else:
            d.ellipse([x - 11, py - 11, x + 11, py + 11], outline=hue, width=2)
    # Footer.
    f_foot = ImageFont.truetype(FONT, 24)
    d.text((384, 940), 'Born, verified, paid \u2014 or gone.', font=f_foot, fill=MUTED, anchor='ma')
    return img


def main():
    bg = Image.open(BG).convert('RGB').resize((W, H), Image.LANCZOS)
    cards = {}
    for g in GENS:
        path = os.path.join(OUT, 'gen-%d.jpg' % g['n'])
        img = card(bg, g)
        img.save(path, 'JPEG', quality=88, optimize=True)
        with open(path, 'rb') as f:
            cards[str(g['n'])] = base64.b64encode(f.read()).decode('ascii')
        print('wrote', path)
    path = os.path.join(OUT, 'gen-x.jpg')
    img = card(bg, FALLBACK)
    img.save(path, 'JPEG', quality=88, optimize=True)
    with open(path, 'rb') as f:
        cards['x'] = base64.b64encode(f.read()).decode('ascii')
    print('wrote', path)
    # Deployable bundle: GitHub's push flow carries UTF-8 text only, so
    # the binary JPGs cannot be pushed. The cards ship as base64 in this
    # JSON file instead, and api/nft-card.js decodes and serves them as
    # real image/jpeg bytes (every wallet displays that).
    import json
    bundle = os.path.join(OUT, 'cards.json')
    with open(bundle, 'w') as f:
        json.dump(cards, f)
    print('wrote', bundle)


if __name__ == '__main__':
    main()
