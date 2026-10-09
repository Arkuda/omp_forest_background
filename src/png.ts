import { promisify } from "node:util";
import { deflate, deflateSync, inflate } from "node:zlib";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const compress = promisify(deflate);
const decompress = promisify(inflate);
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
  return chunk;
}

function assemblePng(width: number, height: number, compressed: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // Eight-bit channels; descriptors require exact integer bytes.
  header[9] = 6; // RGBA, without color-management metadata.
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Original deterministic atlas encoder: one IDAT, filter-zero RGBA scanlines. */
export function encodePng(scanlines: Buffer, width: number, height: number): Buffer {
  return assemblePng(width, height, deflateSync(scanlines, { level: 9 }));
}

/** Runtime frames use the same encoding, but compression yields to the event loop. */
export async function encodePngAsync(scanlines: Buffer, width: number, height: number): Promise<Buffer> {
  return assemblePng(width, height, await compress(scanlines, { level: 9 }));
}

/** Decode only our controlled, metadata-free, single-IDAT RGBA asset format. */
export async function decodeRgbaPng(data: Buffer, width: number, height: number): Promise<Buffer> {
  const invalid = () => new Error("The forest PNG is damaged or has an unexpected format.");
  if (!data.subarray(0, signature.length).equals(signature)) throw invalid();
  let offset = signature.length;
  let compressed: Buffer | undefined;
  for (const type of ["IHDR", "IDAT", "IEND"]) {
    if (offset + 12 > data.length) throw invalid();
    const length = data.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > data.length || data.toString("ascii", offset + 4, offset + 8) !== type) throw invalid();
    if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) throw invalid();
    const contents = data.subarray(offset + 8, end - 4);
    if (type === "IHDR") {
      if (length !== 13 || contents.readUInt32BE(0) !== width || contents.readUInt32BE(4) !== height
        || contents[8] !== 8 || contents[9] !== 6 || contents[10] !== 0 || contents[11] !== 0 || contents[12] !== 0) throw invalid();
    } else if (type === "IDAT") {
      if (length === 0) throw invalid();
      compressed = contents;
    } else if (length !== 0) throw invalid();
    offset = end;
  }
  if (offset !== data.length) throw invalid();
  const stride = width * 4 + 1;
  const scanlines = await decompress(compressed!, { maxOutputLength: stride * height });
  if (scanlines.length !== stride * height) throw invalid();
  for (let y = 0; y < height; y++) if (scanlines[y * stride] !== 0) throw invalid();
  return scanlines;
}
