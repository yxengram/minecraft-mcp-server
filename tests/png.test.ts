import test from 'ava';
import zlib from 'node:zlib';
import { crc32, encodePng } from '../src/png.js';

function chunks(png: Buffer) {
  const result: { type: string; data: Buffer; crcOk: boolean }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    result.push({ type, data, crcOk: crc === crc32(png.subarray(offset + 4, offset + 8 + length)) });
    offset += 12 + length;
  }
  return result;
}

test('crc32 matches the standard check value', (t) => {
  t.is(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('encodePng writes a valid RGB PNG', (t) => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
  const png = encodePng(2, 2, rgb);

  t.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = chunks(png);
  t.deepEqual(parts.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  t.true(parts.every(c => c.crcOk));

  const header = parts[0].data;
  t.is(header.readUInt32BE(0), 2);
  t.is(header.readUInt32BE(4), 2);
  t.is(header[8], 8);
  t.is(header[9], 2);

  const raw = zlib.inflateSync(parts[1].data);
  t.deepEqual([...raw], [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 10, 20, 30]);
});

test('encodePng rejects mismatched data and invalid sizes', (t) => {
  t.throws(() => encodePng(2, 2, new Uint8Array(5)), { message: /Expected 12 bytes/ });
  t.throws(() => encodePng(0, 2, new Uint8Array(0)), { message: /Invalid image size/ });
});
