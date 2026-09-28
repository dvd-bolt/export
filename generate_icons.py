"""
Utility script: generates icon PNG files for the Chrome extension.
Run once from the extension directory: python generate_icons.py
Requires Pillow: pip install Pillow
"""

import os
import sys

SIZES = [16, 32, 48, 128]
SOURCE = r"C:\Users\dvd\.gemini\antigravity\brain\65441516-56b1-4844-9c42-b07ce28cc02f\extension_icon_1781613177996.png"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")

def main():
    try:
        from PIL import Image
    except ImportError:
        print("Pillow not found. Installing...")
        os.system(f"{sys.executable} -m pip install Pillow -q")
        from PIL import Image

    os.makedirs(OUT_DIR, exist_ok=True)

    with Image.open(SOURCE) as img:
        img = img.convert("RGBA")
        for size in SIZES:
            resized = img.resize((size, size), Image.LANCZOS)
            out_path = os.path.join(OUT_DIR, f"icon{size}.png")
            resized.save(out_path, "PNG")
            print(f"  ✓ Saved {out_path}")

    print("\nAll icons generated successfully!")

if __name__ == "__main__":
    main()
