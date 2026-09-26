/**
 * Renders assets/icon.svg into every raster icon the app and installer need:
 *
 *   build/icon.ico   Windows executable, installer and uninstaller (16-256 px)
 *   build/icon.png   1024 px source for macOS (.icns) and Linux packages
 *   assets/icon.png  512 px window / taskbar icon used at runtime
 *
 * Usage: npm run icons
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

const ROOT = new URL('../', import.meta.url);
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

const svg = await readFile(new URL('assets/icon.svg', ROOT), 'utf8');

function render(size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
}

/**
 * 32-bit BMP (DIB) icon entry. Small sizes use BMP rather than PNG because some
 * consumers (older Explorer builds, NSIS) only handle PNG for the 256 px entry.
 */
function encodeDib(image) {
  const { width, height } = image;
  const rgba = image.pixels; // premultiplied RGBA, top-down
  const maskStride = Math.ceil(width / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // XOR bitmap + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(width * height * 4 + maskStride * height, 20);

  const pixels = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(maskStride * height);
  for (let y = 0; y < height; y++) {
    const row = height - 1 - y; // DIBs are stored bottom-up
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = (row * width + x) * 4;
      const alpha = rgba[src + 3];
      const unpremultiply = (value) => (alpha ? Math.min(255, Math.round((value * 255) / alpha)) : 0);
      pixels[dst] = unpremultiply(rgba[src + 2]);
      pixels[dst + 1] = unpremultiply(rgba[src + 1]);
      pixels[dst + 2] = unpremultiply(rgba[src]);
      pixels[dst + 3] = alpha;
      if (alpha === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

function encodeIco(sizes) {
  const entries = sizes.map((size) => {
    const image = render(size);
    return { size, data: size >= 256 ? image.asPng() : encodeDib(image) };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = header.length + entries.length * 16;
  const directory = entries.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.data)]);
}

await mkdir(new URL('build/', ROOT), { recursive: true });

const outputs = {
  'build/icon.ico': encodeIco(ICO_SIZES),
  'build/icon.png': render(1024).asPng(),
  'assets/icon.png': render(512).asPng(),
};

for (const [file, data] of Object.entries(outputs)) {
  await writeFile(new URL(file, ROOT), data);
  console.log(`${file.padEnd(16)} ${(data.length / 1024).toFixed(1)} KB`);
}
