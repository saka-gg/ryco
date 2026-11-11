#!/usr/bin/env python3
"""Generate Ryco's app icons in every variant, and verify their colors.

    python3 -I scripts/generate-app-icon-variants.py           # write, then verify
    python3 -I scripts/generate-app-icon-variants.py --check   # verify only

Needs Pillow and NumPy, and on macOS Xcode 26 or later (Icon Composer's `ictool`, `actool`). The
colors come from `packages/shared/src/appIcon.ts`; the accent is also checked against the
website's `--color-accent`.

Apple platforms get Liquid Glass: each variant is an Icon Composer document (a solid tile and the
R as one glass layer, with Dark and Tinted appearances), so the system lights it like any other
app icon of macOS 26 and iOS 26.

- macOS: the default (Light) compiles with `actool` into the stable app's asset catalog
  (`assets/prod/ryco-macos-Assets.car`, named `AppIcon`), and its `ictool` rendering becomes the
  `.icns` fallback for older macOS (`assets/prod/ryco-macos.iconset`). The other variants are
  rendered once with `ictool` for the Dock at run time (`apps/desktop/resources/app-icons`): the
  Dock can only be given a picture, so those keep the light appearance.
- iPhone: the documents themselves (`apps/mobile/assets/app-icons/AppIcon*.icon`) go into the
  Xcode project, the default as the primary icon and the others as alternate icons.
- Windows and Linux stay flat: each variant recolors the stable artwork pixel by pixel (the mix
  between the white tile and the black R is kept and repainted), so the R's shape, placement and
  edge smoothing match the default icon exactly at every size.
"""

from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SPEC_FILE = ROOT / "packages/shared/src/appIcon.ts"
WEBSITE_CSS = ROOT / "marketing/src/index.css"

FLAT_SOURCES = {
    "windows": ROOT / "assets/prod/ryco-windows.ico",
    "linux": ROOT / "assets/prod/ryco-linux-1024.png",
}
DESKTOP_DIR = ROOT / "apps/desktop/resources/app-icons"
MAC_DOCUMENTS = ROOT / "assets/app-icons/macos"
MAC_ASSET_CATALOG = ROOT / "assets/prod/ryco-macos-Assets.car"
MAC_ICONSET = ROOT / "assets/prod/ryco-macos.iconset"
MAC_1024 = ROOT / "assets/prod/ryco-macos-1024.png"
IOS_DIR = ROOT / "apps/mobile/assets/app-icons"

ICTOOL = Path(
    "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"
)
# The name `actool` compiles the default under, and the app's Info.plist names (CFBundleIconName).
MAC_ICON_NAME = "AppIcon"
MAC_MINIMUM_SYSTEM = "13.0"
# The Dock draws at most 256 points (512 pixels); window icons are smaller still.
DESKTOP_PNG_SIZE = 512

# Apple's macOS icon grid: the 824-point body centred in 1024, over a soft shadow (fitted to
# actool's own rendering: blur 14, 8 down, a quarter black).
MAC_BODY = 824
MAC_INSET = 100
MAC_SHADOW = {"blur": 14, "offset": 8, "opacity": 0.25}

# Where the R sits in each platform's 1024-point icon canvas (APP_ICON_MARK_PATH is drawn on the
# macOS grid): the macOS body is the canvas; iPhone keeps today's smaller R on the full square.
MARK_VIEWBOX = {"macOS": "100 100 824 824", "iOS": "0 0 1024 1024"}

# The stable artwork: a white tile, the R in #141414.
SOURCE_PAPER = 255.0
SOURCE_INK = 20.0
# Below this mix a pixel is tile (the artwork's paper carries ±2 of noise), above 1 - it, R.
SNAP = 0.02

# Glass lights the R from the top; its lower stem keeps the R's own color. In each platform's
# 1024 rendering: a flat patch of tile left of the R, and the lower stem.
SAMPLES = {
    "macOS": {"tile": (120, 480, 180, 540), "R": (300, 660, 340, 700)},
    "iOS": {"tile": (100, 480, 160, 540), "R": (345, 600, 385, 650)},
}
GLASS_TOLERANCE = 4

SRGB = ImageCms.createProfile("sRGB")


def hex_rgb(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.array([int(value[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float64)


def rgb_hex(rgb) -> str:
    return "#" + "".join(f"{int(round(c)):02x}" for c in rgb)


def icon_color(value: str) -> str:
    rgb = hex_rgb(value) / 255.0
    return "srgb:" + ",".join(f"{c:.5f}" for c in rgb) + ",1.00000"


def read_variants() -> dict[str, dict]:
    """Every variant from the shared spec: name -> colors and generated-file stem (None: default)."""
    source = SPEC_FILE.read_text()
    constants = dict(re.findall(r'export const (APP_ICON_\w+) = "(#[0-9a-fA-F]{6})";', source))
    variants: dict[str, dict] = {}
    pattern = re.compile(
        r"(\w+): \{\s*label: \"[^\"]*\",\s*description: \"[^\"]*\",\s*"
        r"tile: (\w+),\s*mark: (\w+),\s*asset: (?:\"(\w+)\"|null),"
    )
    for name, tile, mark, asset in pattern.findall(source):
        variants[name] = {
            "tile": constants[tile],
            "mark": constants[mark],
            "asset": asset or None,
            "ink": constants["APP_ICON_INK"],
            "paper": constants["APP_ICON_PAPER"],
            "accent": constants["APP_ICON_ACCENT"],
        }
    if len(variants) != 4 or sum(v["asset"] is None for v in variants.values()) != 1:
        sys.exit(f"Expected 4 variants, one of them the default, in {SPEC_FILE}")
    website = re.search(r"--color-accent:\s*(#[0-9a-fA-F]{6});", WEBSITE_CSS.read_text())
    if not website or website.group(1).lower() != constants["APP_ICON_ACCENT"].lower():
        sys.exit(
            f"APP_ICON_ACCENT {constants['APP_ICON_ACCENT']} differs from the website accent "
            f"{website.group(1) if website else '(missing)'}"
        )
    return variants


def ios_icon_name(variant: dict) -> str:
    """`iosAlternateAppIconName` in `@ryco/shared/appIcon`; the default is the primary icon."""
    return "AppIcon" if variant["asset"] is None else f"AppIcon-{variant['asset']}"


# ---------------------------------------------------------------------------------------------
# Icon Composer documents


def dark_mark(variant: dict) -> str:
    """The R in Dark appearance, where the system darkens every tile: a black R turns white, or
    orange on the orange tile (which then reads as Ember); a light R keeps its color."""
    if variant["mark"] != variant["ink"]:
        return variant["mark"]
    return variant["accent"] if variant["tile"] == variant["accent"] else variant["paper"]


def mark_path() -> str:
    source = SPEC_FILE.read_text()
    return re.search(r'APP_ICON_MARK_PATH =\s*"([^"]+)"', source).group(1)


def write_document(directory: Path, variant: dict, platform: str) -> None:
    """One Icon Composer document: the tile as the solid background, the R as a glass layer."""
    shutil.rmtree(directory, ignore_errors=True)
    (directory / "Assets").mkdir(parents=True)
    (directory / "Assets/R.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" '
        f'viewBox="{MARK_VIEWBOX[platform]}"><path d="{mark_path()}" fill="#000000"/></svg>\n'
    )
    document = {
        "fill": {"solid": icon_color(variant["tile"])},
        "groups": [
            {
                "layers": [
                    {
                        # The layer's fill paints the R; Tinted reads it as brightness.
                        "fill-specializations": [
                            {"value": {"solid": icon_color(variant["mark"])}},
                            {"appearance": "dark", "value": {"solid": icon_color(dark_mark(variant))}},
                            {"appearance": "tinted", "value": {"solid": icon_color(variant["paper"])}},
                        ],
                        "glass": True,
                        "image-name": "R.svg",
                        "name": "R",
                    }
                ],
                "shadow": {"kind": "neutral", "opacity": 0.5},
                "specular": True,
                # Opaque glass: the R keeps its own color instead of mixing in the tile's.
                "translucency": {"enabled": False, "value": 0.5},
            }
        ],
        "supported-platforms": {"squares": [platform]},
    }
    text = json.dumps(document, indent=2)
    # The repository's formatter keeps a one-string array on one line.
    text = re.sub(r'\[\s*("[^"]*")\s*\]', r"[\1]", text)
    (directory / "icon.json").write_text(text + "\n")


def render(document: Path, platform: str, size: int, rendition: str = "Default") -> Image.Image:
    """`ictool`'s rendering of a document's icon body, in sRGB (it renders in Display P3)."""
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "icon.png"
        subprocess.run(
            [
                str(ICTOOL), str(document), "--export-image", "--output-file", str(output),
                "--platform", platform, "--rendition", rendition,
                "--width", str(size), "--height", str(size), "--scale", "1",
            ],
            check=True,
            capture_output=True,
        )
        image = Image.open(output)
        image.load()
    profile = image.info.get("icc_profile")
    alpha = image.convert("RGBA").getchannel("A")
    rgb = image.convert("RGB")
    if profile:
        rgb = ImageCms.profileToProfile(
            rgb, ImageCms.ImageCmsProfile(io.BytesIO(profile)), SRGB, outputMode="RGB"
        )
    rgb.putalpha(alpha)
    return rgb


def mac_icon(document: Path) -> Image.Image:
    """A document as a 1024-pixel macOS icon: the body on Apple's grid, over its shadow."""
    body = render(document, "macOS", MAC_BODY)
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    mask = Image.new("L", (1024, 1024), 0)
    mask.paste(body.getchannel("A"), (MAC_INSET, MAC_INSET + MAC_SHADOW["offset"]))
    shadow_alpha = mask.filter(ImageFilter.GaussianBlur(MAC_SHADOW["blur"])).point(
        lambda value: round(value * MAC_SHADOW["opacity"])
    )
    canvas.putalpha(shadow_alpha)
    canvas.alpha_composite(body, (MAC_INSET, MAC_INSET))
    return canvas


def compile_asset_catalog(document: Path) -> None:
    """The default's asset catalog: what macOS 26 lights live, in every appearance."""
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        source = work / f"{MAC_ICON_NAME}.icon"
        shutil.copytree(document, source)
        out = work / "out"
        out.mkdir()
        # actool runs as a daemon: every path must be absolute.
        subprocess.run(
            [
                "xcrun", "actool", str(source), "--compile", str(out),
                "--platform", "macosx", "--target-device", "mac",
                "--minimum-deployment-target", MAC_MINIMUM_SYSTEM,
                "--app-icon", MAC_ICON_NAME, "--include-all-app-icons",
                "--output-partial-info-plist", str(out / "info.plist"),
                "--output-format", "human-readable-text", "--errors",
            ],
            check=True,
            capture_output=True,
        )
        shutil.copyfile(out / "Assets.car", MAC_ASSET_CATALOG)


def write_iconset(icon: Image.Image) -> None:
    """The `.icns` fallback for macOS before asset-catalog icons, at every size."""
    shutil.rmtree(MAC_ICONSET, ignore_errors=True)
    MAC_ICONSET.mkdir(parents=True)
    for points in (16, 32, 128, 256, 512):
        for scale, suffix in ((1, ""), (2, "@2x")):
            pixels = points * scale
            icon.resize((pixels, pixels), Image.Resampling.LANCZOS).save(
                MAC_ICONSET / f"icon_{points}x{points}{suffix}.png", optimize=True
            )
    icon.save(MAC_1024, optimize=True)


# ---------------------------------------------------------------------------------------------
# Flat recolors (Windows, Linux)


def mix(rgba: np.ndarray) -> np.ndarray:
    """How much of the R each pixel holds: 0 tile, 1 R; snapped at the ends."""
    lum = rgba[..., :3].astype(np.float64).mean(axis=-1)
    t = np.clip((SOURCE_PAPER - lum) / (SOURCE_PAPER - SOURCE_INK), 0.0, 1.0)
    t[t < SNAP] = 0.0
    t[t > 1.0 - SNAP] = 1.0
    # A soft outer edge is tile, whatever color the artwork stored under it.
    t[rgba[..., 3] < 255] = 0.0
    return t


def recolor(image: Image.Image, tile: str, mark: str) -> Image.Image:
    rgba = np.array(image.convert("RGBA"))
    t = mix(rgba)[..., None]
    rgb = hex_rgb(tile) * (1.0 - t) + hex_rgb(mark) * t
    return Image.fromarray(np.dstack([np.round(rgb).astype(np.uint8), rgba[..., 3]]))


def ico_frames(path: Path) -> list[Image.Image]:
    ico = Image.open(path)
    return [ico.ico.getimage(size).convert("RGBA") for size in sorted(ico.info["sizes"])]


def desktop_outputs(asset: str) -> dict[str, Path]:
    return {
        "macos": DESKTOP_DIR / f"{asset}-macos.png",
        "windows": DESKTOP_DIR / f"{asset}-windows.ico",
        "linux": DESKTOP_DIR / f"{asset}-linux.png",
    }


# ---------------------------------------------------------------------------------------------
# Generate


def generate(variants: dict[str, dict]) -> None:
    if not ICTOOL.exists():
        sys.exit(f"Icon Composer's ictool is missing ({ICTOOL}): install Xcode 26 or later.")
    DESKTOP_DIR.mkdir(parents=True, exist_ok=True)
    IOS_DIR.mkdir(parents=True, exist_ok=True)
    for name, variant in variants.items():
        mac_document = MAC_DOCUMENTS / f"{name}.icon"
        write_document(mac_document, variant, "macOS")
        write_document(IOS_DIR / f"{ios_icon_name(variant)}.icon", variant, "iOS")
        asset = variant["asset"]
        if asset is None:
            compile_asset_catalog(mac_document)
            write_iconset(mac_icon(mac_document))
            print(f"generated {name} (app icon)")
            continue
        paths = desktop_outputs(asset)
        dock = mac_icon(mac_document).resize(
            (DESKTOP_PNG_SIZE, DESKTOP_PNG_SIZE), Image.Resampling.LANCZOS
        )
        dock.save(paths["macos"], optimize=True)
        tile, mark = variant["tile"], variant["mark"]
        linux = recolor(Image.open(FLAT_SOURCES["linux"]), tile, mark)
        linux.resize((DESKTOP_PNG_SIZE, DESKTOP_PNG_SIZE), Image.Resampling.LANCZOS).convert(
            "RGB"
        ).save(paths["linux"], optimize=True)
        frames = [recolor(frame, tile, mark) for frame in ico_frames(FLAT_SOURCES["windows"])]
        frames[-1].save(
            paths["windows"],
            format="ICO",
            sizes=[frame.size for frame in frames],
            append_images=frames[:-1],
        )
        print(f"generated {name}")


# ---------------------------------------------------------------------------------------------
# Verify


def erode(mask: np.ndarray, radius: int) -> np.ndarray:
    """Pixels whose whole (2 * radius + 1)-square neighborhood is in the mask."""
    out = mask.copy()
    padded = np.pad(mask, radius, constant_values=False)
    height, width = mask.shape
    for dy in range(2 * radius + 1):
        for dx in range(2 * radius + 1):
            out &= padded[dy : dy + height, dx : dx + width]
    return out


def verify_flat(label, source, output, tile, mark, resized=False):
    """Every pure-tile and pure-R pixel of the source must be exactly the variant's color.

    A downscaled file rings a little beside every edge, so there only the pixels at least two
    pixels inside a region count, within 1 of 255 for resampling rounding, and the edges are
    not compared.
    """
    src = np.array(source.convert("RGBA"))
    out = np.array(output.convert("RGBA")).astype(np.int64)
    if src.shape != out.shape:
        return [f"{label}: size {out.shape[:2]} != source {src.shape[:2]}"], None
    problems: list[str] = []
    t = mix(src)
    opaque = src[..., 3] == 255
    tile_mask, mark_mask = opaque & (t == 0.0), t == 1.0
    if resized:
        tile_mask, mark_mask = erode(tile_mask, 2), erode(mark_mask, 2)
    measured = {}
    for region, mask, expected in (
        ("tile", tile_mask, hex_rgb(tile)),
        ("R", mark_mask, hex_rgb(mark)),
    ):
        pixels = out[mask][:, :3]
        if len(pixels) == 0:
            problems.append(f"{label}: no {region} pixels")
            continue
        worst = int(np.abs(pixels - expected).max())
        colors, counts = np.unique(pixels, axis=0, return_counts=True)
        measured[region] = rgb_hex(colors[counts.argmax()])
        if worst > (1 if resized else 0):
            problems.append(f"{label}: {region} off by up to {worst} from {rgb_hex(expected)}")
    edge = opaque & (t > 0.0) & (t < 1.0)
    if edge.any() and not resized:
        expected_edge = hex_rgb(tile) * (1 - t[edge][:, None]) + hex_rgb(mark) * t[edge][:, None]
        worst_edge = float(np.abs(out[edge][:, :3] - expected_edge).max())
        if worst_edge > 1.0:
            problems.append(f"{label}: edge pixels stray by {worst_edge:.1f}")
    if not resized and not np.array_equal(src[..., 3], out[..., 3]):
        problems.append(f"{label}: transparency differs from the source")
    return problems, measured


def sample(image: Image.Image, box) -> np.ndarray:
    pixels = np.array(image.convert("RGB")).astype(np.float64)
    x0, y0, x1, y1 = box
    return pixels[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)


def verify_glass(label, body: Image.Image, platform, tile, mark):
    """A rendering's flat tile and lower stem must be the variant's colors (glass lights the
    rest of the R)."""
    problems: list[str] = []
    measured = {}
    for region, expected in (("tile", tile), ("R", mark)):
        if expected is None:
            continue
        got = sample(body, SAMPLES[platform][region])
        measured[region] = rgb_hex(got)
        worst = float(np.abs(got - hex_rgb(expected)).max())
        if worst > GLASS_TOLERANCE:
            problems.append(f"{label}: {region} {rgb_hex(got)} is not {expected}")
    return problems, measured


def verify(variants: dict[str, dict]) -> bool:
    problems: list[str] = []
    rows: list[tuple[str, str, str, str, dict]] = []
    can_render = ICTOOL.exists()
    if not can_render:
        print("(ictool missing: Apple renderings are not re-checked)")
    for name, variant in variants.items():
        tile, mark, asset = variant["tile"], variant["mark"], variant["asset"]
        mac_document = MAC_DOCUMENTS / f"{name}.icon"
        ios_document = IOS_DIR / f"{ios_icon_name(variant)}.icon"
        for document in (mac_document, ios_document):
            if not (document / "icon.json").exists():
                problems.append(f"{name}: {document.relative_to(ROOT)} is missing")
        if can_render:
            for platform, document in (("macOS", mac_document), ("iOS", ios_document)):
                body = render(document, platform, 1024)
                found, measured = verify_glass(f"{name} {platform}", body, platform, tile, mark)
                problems.extend(found)
                rows.append((name, f"{platform} glass", tile, mark, measured))
                dark = render(document, platform, 1024, "Dark")
                # The system picks the dark tile; the R must be the one asked for.
                found, measured = verify_glass(
                    f"{name} {platform} dark", dark, platform, None, dark_mark(variant)
                )
                problems.extend(found)
                rows.append((name, f"{platform} dark R", "-", dark_mark(variant), measured))
        if asset is None:
            if not MAC_ASSET_CATALOG.exists():
                problems.append(f"{MAC_ASSET_CATALOG.relative_to(ROOT)} is missing")
            icon = Image.open(MAC_1024).convert("RGBA")
            # The body sits on Apple's grid: opaque from 100 to 923.
            alpha = np.array(icon.getchannel("A"))
            ys, xs = np.where(alpha > 250)
            if (xs.min(), xs.max(), ys.min(), ys.max()) != (100, 923, 100, 923):
                problems.append(f"{MAC_1024.relative_to(ROOT)}: body not on the 824 grid")
            body = icon.crop((100, 100, 924, 924)).resize((1024, 1024), Image.Resampling.LANCZOS)
            found, measured = verify_glass(f"{name} .icns", body, "macOS", tile, mark)
            problems.extend(found)
            rows.append((name, "macOS .icns", tile, mark, measured))
            continue
        paths = desktop_outputs(asset)
        dock = Image.open(paths["macos"]).convert("RGBA")
        if dock.size != (DESKTOP_PNG_SIZE, DESKTOP_PNG_SIZE):
            problems.append(f"{name} dock: size {dock.size}")
        else:
            body = dock.crop((50, 50, 462, 462)).resize((1024, 1024), Image.Resampling.LANCZOS)
            found, measured = verify_glass(f"{name} Dock", body, "macOS", tile, mark)
            problems.extend(found)
            rows.append((name, "macOS Dock", tile, mark, measured))
        source = Image.open(FLAT_SOURCES["linux"]).convert("RGBA")
        output = Image.open(paths["linux"])
        found, measured = verify_flat(
            f"{name} linux",
            source.resize(output.size, Image.Resampling.LANCZOS),
            output,
            tile,
            mark,
            resized=True,
        )
        problems.extend(found)
        rows.append((name, "linux", tile, mark, measured or {}))
        ico = Image.open(paths["windows"])
        sizes = sorted(ico.info["sizes"])
        for frame in ico_frames(FLAT_SOURCES["windows"]):
            if frame.size not in sizes:
                problems.append(f"{name} windows: missing {frame.size[0]}px")
                continue
            found, measured = verify_flat(
                f"{name} windows {frame.size[0]}px", frame, ico.ico.getimage(frame.size), tile, mark
            )
            problems.extend(found)
            rows.append((name, f"windows {frame.size[0]}px", tile, mark, measured or {}))

    print(f"\n{'variant':<10}{'where':<16}{'tile want/got':<22}{'R want/got':<22}")
    for name, where, tile, mark, measured in rows:
        print(
            f"{name:<10}{where:<16}"
            f"{tile + ' ' + measured.get('tile', '?'):<22}"
            f"{mark + ' ' + measured.get('R', '?'):<22}"
        )
    if problems:
        print("\nFAILED:\n  " + "\n  ".join(problems))
        return False
    print("\nAll icon colors match the shared spec.")
    return True


def main() -> None:
    variants = read_variants()
    if "--check" not in sys.argv:
        generate(variants)
    sys.exit(0 if verify(variants) else 1)


if __name__ == "__main__":
    main()
