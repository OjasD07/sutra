"""Render the GitHub PNG assets (python3 scripts/render-github-assets.py).

The social card is rasterised from assets/github-social-card.svg with headless
Chrome when available, because Pillow without libraqm cannot shape Devanagari
conjuncts (सूत्र would render as सूत्‌र). The avatar has no text and is drawn with Pillow.
"""

import shutil
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets"
SCALE = 2
NAVY = "#101923"
IVORY = "#F4F1E8"
GOLD = "#F5B84B"
STEEL = "#9CAABA"
GREEN = "#52B788"


def font(path, size):
    return ImageFont.truetype(path, size * SCALE)


SANS = "/System/Library/Fonts/SFNS.ttf"
MONO = "/System/Library/Fonts/SFNSMono.ttf"
DEVANAGARI = "/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc"


def pos(*xy):
    return tuple(round(n * SCALE) for n in xy)


def line(draw, points, color, width):
    points = [pos(*p) for p in points]
    w = round(width * SCALE)
    draw.line(points, fill=color, width=w, joint="curve")
    r = w / 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((round(x-r), round(y-r), round(x+r), round(y+r)), fill=color)


def cubic(a, b, c, d, steps=20):
    return [(
        (1-t)**3*a[0] + 3*(1-t)**2*t*b[0] + 3*(1-t)*t*t*c[0] + t**3*d[0],
        (1-t)**3*a[1] + 3*(1-t)**2*t*b[1] + 3*(1-t)*t*t*c[1] + t**3*d[1],
    ) for t in (i / steps for i in range(steps + 1))]


def mark(draw, x, y, scale):
    p = lambda point: (x + point[0]*scale, y + point[1]*scale)
    line(draw, [p((12, 18)), p((52, 18))], IVORY, 5*scale)
    path = [p((37, 18)), p((37, 24))]
    path += [p(q) for q in cubic((37,24),(37,31),(23,28),(23,36))[1:]]
    path += [p(q) for q in cubic((23,36),(23,44),(37,41),(37,47))[1:]]
    line(draw, path, GOLD, 5*scale)
    cx, cy = p((37,18))
    draw.ellipse(pos(cx-4.5*scale,cy-4.5*scale,cx+4.5*scale,cy+4.5*scale), fill=NAVY, outline=GOLD, width=round(3*scale*SCALE))
    cx, cy = p((37,50))
    draw.ellipse(pos(cx-5.5*scale,cy-5.5*scale,cx+5.5*scale,cy+5.5*scale), fill=GOLD)


def wordmark(draw, x, y, scale):
    p = lambda point: (x + point[0]*scale, y + point[1]*scale)
    def stroke(points):
        line(draw, [p(q) for q in points], IVORY, 5*scale)
    s = [(30,6),(12,6)]
    s += cubic((12,6),(6,6),(4,9),(4,13))[1:]
    s += cubic((4,13),(4,17),(6,20),(12,20))[1:]
    s += [(22,20)] + cubic((22,20),(28,20),(30,23),(30,27))[1:]
    s += cubic((30,27),(30,31),(28,34),(22,34))[1:] + [(4,34)]
    stroke(s)
    u = [(44,6),(44,25)] + cubic((44,25),(44,31),(47,34),(53,34))[1:]
    u += [(57,34)] + cubic((57,34),(63,34),(66,31),(66,25))[1:] + [(66,6)]
    stroke(u)
    stroke([(80,6),(106,6)]); stroke([(93,6),(93,34)])
    stroke([(120,34),(120,6),(136,6)])
    stroke(cubic((136,6),(142,6),(144,9),(144,13)))
    stroke(cubic((144,13),(144,17),(142,20),(136,20)))
    stroke([(136,20),(120,20)]); stroke([(134,20),(144,34)])
    stroke([(156,34),(169,6),(182,34)]); stroke([(161,24),(177,24)])


def label(draw, xy, text, size, fill, family=SANS, stroke=0):
    draw.text(pos(*xy), text, font=font(family,size), fill=fill, stroke_width=stroke*SCALE, anchor="lt")


def gradient(size):
    image = Image.new("RGB", (size[0]*SCALE,size[1]*SCALE))
    top = (16,25,35); bottom = (29,48,64)
    pixels = image.load()
    for y in range(image.height):
        t = y / (image.height - 1)
        color = tuple(round(a*(1-t)+b*t) for a,b in zip(top,bottom))
        for x in range(image.width): pixels[x,y] = color
    return image


def social_card():
    image = gradient((1280,640)); d = ImageDraw.Draw(image)
    for x in range(0,1281,48): d.line([pos(x,0),pos(x,640)], fill="#233542",width=1)
    for y in range(0,641,48): d.line([pos(0,y),pos(1280,y)], fill="#233542",width=1)
    d.rounded_rectangle(pos(88,86,198,196),radius=26*SCALE,fill="#223240",outline="#385061",width=2)
    mark(d,103,101,1.25)
    wordmark(d,237,106,2.13)
    label(d,(242,200),"सूत्र",36,GOLD,DEVANAGARI)
    label(d,(88,292),"The thread that connects",43,IVORY)
    label(d,(88,350),"intelligence to action.",43,IVORY)
    label(d,(91,404),"An open-source AI coding agent for the terminal.",20,STEEL,MONO)
    d.rounded_rectangle(pos(88,463,1192,574),radius=16*SCALE,fill="#0C141D",outline="#385061",width=2)
    line(d,[(137,500),(1143,500)],GOLD,3)
    for x,c in [(137,GOLD),(478,GOLD),(809,GOLD),(1143,GREEN)]:
        d.ellipse(pos(x-11,489,x+11,511),fill=c)
    for x,s in [(110,"read"),(451,"plan"),(782,"edit")]: label(d,(x,526),s,22,IVORY,MONO)
    label(d,(1103,529),"test",18,"#C4E8D4",MONO)
    return image.resize((1280,640),Image.Resampling.LANCZOS)


def avatar():
    image = Image.new("RGB",(512*SCALE,512*SCALE),NAVY); d=ImageDraw.Draw(image)
    d.rounded_rectangle(pos(20,20,492,492),radius=110*SCALE,fill="#182938",outline="#385061",width=3*SCALE)
    mark(d,0,0,8)
    return image.resize((512,512),Image.Resampling.LANCZOS)


CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome", "chromium", "chromium-browser",
]


def find_chrome():
    for c in CHROME_CANDIDATES:
        if Path(c).exists() or shutil.which(c):
            return c
    return None


def social_card_from_svg(chrome):
    svg = (OUT / "github-social-card.svg").resolve()
    with tempfile.TemporaryDirectory() as tmp:
        html = Path(tmp) / "card.html"
        html.write_text(f'<!doctype html><meta charset="utf-8"><style>html,body{{margin:0;background:#101923}}</style><img src="{svg.as_uri()}" width="1280" height="640">')
        shot = Path(tmp) / "card.png"
        subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
                        "--force-device-scale-factor=1", "--window-size=1280,640", f"--screenshot={shot}", html.as_uri()],
                       check=True, capture_output=True)
        Image.open(shot).convert("RGB").save(OUT / "github-social-card.png", optimize=True)


if __name__ == "__main__":
    chrome = find_chrome()
    if chrome:
        social_card_from_svg(chrome)
    else:
        print("warning: Chrome not found; drawing the social card with Pillow (Devanagari may not shape correctly)")
        social_card().save(OUT / "github-social-card.png",optimize=True)
    avatar().save(OUT / "github-avatar.png",optimize=True)
