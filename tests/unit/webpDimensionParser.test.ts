import { describe, expect, test } from 'bun:test'
import { parseWebPDimensions } from '../../src/utils/imageResizer.js'

function makeRIFFHeader(payloadSize: number): Buffer {
  const buf = Buffer.alloc(12)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(payloadSize + 4, 4) // file size minus 8, plus WEBP
  buf.write('WEBP', 8)
  return buf
}

function makeVP8Chunk(width: number, height: number): Buffer {
  // VP8 chunk: 3-byte frame tag + start code + 16-bit LE width + 16-bit LE height
  const payload = Buffer.alloc(10)
  payload[0] = 0x00 // frame tag byte 0
  payload[1] = 0x00 // frame tag byte 1
  payload[2] = 0x00 // frame tag byte 2
  payload[3] = 0x9d // start code
  payload[4] = 0x01
  payload[5] = 0x2a
  payload.writeUInt16LE(width & 0x3fff, 6)
  payload.writeUInt16LE(height & 0x3fff, 8)

  const header = Buffer.alloc(8)
  header.write('VP8 ', 0)
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function makeVP8LChunk(width: number, height: number): Buffer {
  // VP8L chunk: signature 0x2F + 32-bit LE packed (14-bit width-1, 14-bit height-1)
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  const payload = Buffer.alloc(5)
  payload[0] = 0x2f
  payload.writeUInt32LE(bits, 1)

  const header = Buffer.alloc(8)
  header.write('VP8L', 0)
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function makeVP8XChunk(width: number, height: number): Buffer {
  // VP8X chunk: 4 bytes flags + 24-bit LE (width-1) + 24-bit LE (height-1)
  const payload = Buffer.alloc(10)
  payload.writeUInt32LE(0, 0) // flags
  const w = width - 1
  const h = height - 1
  payload[4] = w & 0xff
  payload[5] = (w >> 8) & 0xff
  payload[6] = (w >> 16) & 0xff
  payload[7] = h & 0xff
  payload[8] = (h >> 8) & 0xff
  payload[9] = (h >> 16) & 0xff

  const header = Buffer.alloc(8)
  header.write('VP8X', 0)
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function makeWebP(chunk: Buffer): Buffer {
  const riff = makeRIFFHeader(chunk.length)
  return Buffer.concat([riff, chunk])
}

describe('parseWebPDimensions', () => {
  describe('VP8 (lossy)', () => {
    test('parses valid dimensions', () => {
      const buf = makeWebP(makeVP8Chunk(800, 600))
      expect(parseWebPDimensions(buf)).toEqual({ width: 800, height: 600 })
    })

    test('parses large dimensions', () => {
      const buf = makeWebP(makeVP8Chunk(4000, 3000))
      expect(parseWebPDimensions(buf)).toEqual({ width: 4000, height: 3000 })
    })

    test('parses 1x1', () => {
      const buf = makeWebP(makeVP8Chunk(1, 1))
      expect(parseWebPDimensions(buf)).toEqual({ width: 1, height: 1 })
    })

    test('returns null for zero width', () => {
      const buf = makeWebP(makeVP8Chunk(0, 600))
      expect(parseWebPDimensions(buf)).toBeNull()
    })

    test('returns null for zero height', () => {
      const buf = makeWebP(makeVP8Chunk(800, 0))
      expect(parseWebPDimensions(buf)).toBeNull()
    })
  })

  describe('VP8L (lossless)', () => {
    test('parses valid dimensions', () => {
      const buf = makeWebP(makeVP8LChunk(1920, 1080))
      expect(parseWebPDimensions(buf)).toEqual({ width: 1920, height: 1080 })
    })

    test('parses 1x1', () => {
      const buf = makeWebP(makeVP8LChunk(1, 1))
      expect(parseWebPDimensions(buf)).toEqual({ width: 1, height: 1 })
    })

    test('parses max 14-bit dimensions', () => {
      const buf = makeWebP(makeVP8LChunk(16383, 16383))
      expect(parseWebPDimensions(buf)).toEqual({ width: 16383, height: 16383 })
    })
  })

  describe('VP8X (extended)', () => {
    test('parses valid dimensions', () => {
      const buf = makeWebP(makeVP8XChunk(2560, 1440))
      expect(parseWebPDimensions(buf)).toEqual({ width: 2560, height: 1440 })
    })

    test('parses 1x1', () => {
      const buf = makeWebP(makeVP8XChunk(1, 1))
      expect(parseWebPDimensions(buf)).toEqual({ width: 1, height: 1 })
    })

    test('parses large canvas dimensions', () => {
      const buf = makeWebP(makeVP8XChunk(8192, 4096))
      expect(parseWebPDimensions(buf)).toEqual({ width: 8192, height: 4096 })
    })
  })

  describe('invalid inputs', () => {
    test('returns null for empty buffer', () => {
      expect(parseWebPDimensions(Buffer.alloc(0))).toBeNull()
    })

    test('returns null for too-short buffer', () => {
      expect(parseWebPDimensions(Buffer.alloc(10))).toBeNull()
    })

    test('returns null for non-RIFF header', () => {
      const buf = Buffer.alloc(30)
      buf.write('NOTARIFF', 0)
      expect(parseWebPDimensions(buf)).toBeNull()
    })

    test('returns null for RIFF but not WEBP', () => {
      const buf = Buffer.alloc(30)
      buf.write('RIFF', 0)
      buf.writeUInt32LE(22, 4)
      buf.write('AVI ', 8)
      expect(parseWebPDimensions(buf)).toBeNull()
    })

    test('returns null for truncated VP8 payload', () => {
      const riff = makeRIFFHeader(8)
      const chunkHeader = Buffer.alloc(8)
      chunkHeader.write('VP8 ', 0)
      chunkHeader.writeUInt32LE(10, 4) // claims 10 bytes but we won't provide them
      const buf = Buffer.concat([riff, chunkHeader])
      expect(parseWebPDimensions(buf)).toBeNull()
    })

    test('returns null for VP8 with bad start code', () => {
      const payload = Buffer.alloc(10)
      payload[3] = 0x00 // wrong start code
      payload[4] = 0x00
      payload[5] = 0x00
      payload.writeUInt16LE(800, 6)
      payload.writeUInt16LE(600, 8)
      const header = Buffer.alloc(8)
      header.write('VP8 ', 0)
      header.writeUInt32LE(10, 4)
      const buf = makeWebP(Buffer.concat([header, payload]))
      expect(parseWebPDimensions(buf)).toBeNull()
    })

    test('returns null for VP8L with bad signature byte', () => {
      const payload = Buffer.alloc(5)
      payload[0] = 0x00 // wrong signature (should be 0x2f)
      payload.writeUInt32LE(799 | (1079 << 14), 1)
      const header = Buffer.alloc(8)
      header.write('VP8L', 0)
      header.writeUInt32LE(5, 4)
      const buf = makeWebP(Buffer.concat([header, payload]))
      expect(parseWebPDimensions(buf)).toBeNull()
    })

    test('returns null for WEBP with no dimension chunks', () => {
      // Unknown chunk type
      const payload = Buffer.alloc(4)
      const header = Buffer.alloc(8)
      header.write('ALPH', 0)
      header.writeUInt32LE(4, 4)
      const buf = makeWebP(Buffer.concat([header, payload]))
      expect(parseWebPDimensions(buf)).toBeNull()
    })

    test('returns null for non-WebP buffer (PNG)', () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(parseWebPDimensions(png)).toBeNull()
    })

    test('returns null for non-WebP buffer (JPEG)', () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
      expect(parseWebPDimensions(jpeg)).toBeNull()
    })
  })
})
