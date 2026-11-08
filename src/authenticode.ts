import { createHash } from 'node:crypto';

export type PeArchitecture = 'x86' | 'x64' | 'arm64';
export interface PeImageDigest {
  readonly architecture: PeArchitecture;
  readonly sha256: string;
  readonly bodyBytes: number;
  readonly certificateBytes: number;
}

export class PeImageError extends Error {
  override readonly name = 'PeImageError';
  constructor() { super('invalid or unsupported supervisor PE image'); }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
function requireImage(condition: unknown): asserts condition {
  if (!condition) throw new PeImageError();
}

/**
 * Authenticode SHA256 for the canonical Roslyn images we ship. This is an image
 * digest, not certificate-chain validation. A host may add or replace a signature.
 *
 * Accept contiguous, non-overlapping raw sections with no overlay, followed only
 * by an optional aligned WIN_CERTIFICATE table. Refusing other layouts keeps an
 * attacker-controlled certificate offset from hiding executable bytes. For this
 * canonical layout, hashing the headers and ordered sections is the PE image hash
 * excluding CheckSum, the security directory entry and the certificate table.
 */
export function authenticodeImage(input: Uint8Array): PeImageDigest {
  requireImage(input instanceof Uint8Array && input.byteLength >= 512 && input.byteLength <= MAX_IMAGE_BYTES);
  // Own the bytes: no caller can change a backing buffer between parsing and hashing.
  const image = Buffer.from(input);
  const span = (offset: number, length: number): void => {
    requireImage(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= image.length);
  };
  requireImage(image.readUInt16LE(0) === 0x5a4d);
  const pe = image.readUInt32LE(0x3c);
  requireImage(pe >= 64 && pe <= 4096);
  span(pe, 24);
  requireImage(image.readUInt32LE(pe) === 0x00004550);
  const machine = image.readUInt16LE(pe + 4), sections = image.readUInt16LE(pe + 6);
  const optionalBytes = image.readUInt16LE(pe + 20), optional = pe + 24;
  requireImage(sections > 0 && sections <= 96);
  span(optional, optionalBytes);
  requireImage(optionalBytes >= 2);
  const magic = image.readUInt16LE(optional);
  requireImage((magic === 0x10b && optionalBytes === 224 && machine === 0x14c)
    || (magic === 0x20b && optionalBytes === 240 && (machine === 0x8664 || machine === 0xaa64)));
  const architecture: PeArchitecture = machine === 0x14c ? 'x86' : machine === 0x8664 ? 'x64' : 'arm64';
  const directory = optional + (magic === 0x10b ? 96 : 112);
  const directoryCount = image.readUInt32LE(directory - 4);
  requireImage(directoryCount >= 5 && directoryCount <= 16);
  const security = directory + 4 * 8, checksum = optional + 64;
  const fileAlignment = image.readUInt32LE(optional + 36), headers = image.readUInt32LE(optional + 60);
  requireImage(fileAlignment >= 512 && fileAlignment <= 65536 && (fileAlignment & (fileAlignment - 1)) === 0);
  requireImage(headers > security + 8 && headers % fileAlignment === 0);
  span(0, headers);
  const sectionTable = optional + optionalBytes;
  requireImage(sectionTable + sections * 40 <= headers);
  const ranges: { offset: number; size: number }[] = [];
  for (let i = 0; i < sections; i++) {
    const entry = sectionTable + i * 40, size = image.readUInt32LE(entry + 16), offset = image.readUInt32LE(entry + 20);
    if (size === 0) continue;
    requireImage(size % fileAlignment === 0 && offset % fileAlignment === 0);
    span(offset, size);
    ranges.push({ offset, size });
  }
  requireImage(ranges.length > 0);
  ranges.sort((a, b) => a.offset - b.offset);
  let bodyEnd = headers;
  for (const range of ranges) {
    requireImage(range.offset === bodyEnd);
    bodyEnd += range.size;
  }
  const certificateOffset = image.readUInt32LE(security), certificateBytes = image.readUInt32LE(security + 4);
  if (certificateOffset === 0) {
    requireImage(certificateBytes === 0 && image.length === bodyEnd);
  } else {
    requireImage(certificateOffset === bodyEnd && certificateOffset % 8 === 0 && certificateBytes >= 8 && certificateBytes % 8 === 0);
    span(certificateOffset, certificateBytes);
    requireImage(certificateOffset + certificateBytes === image.length);
    let cursor = certificateOffset, count = 0;
    while (cursor < image.length) {
      requireImage(++count <= 64);
      span(cursor, 8);
      const length = image.readUInt32LE(cursor);
      requireImage(length >= 8 && image.readUInt16LE(cursor + 4) === 0x0200 && image.readUInt16LE(cursor + 6) === 0x0002);
      const aligned = Math.ceil(length / 8) * 8;
      span(cursor, aligned);
      for (let i = length; i < aligned; i++) requireImage(image[cursor + i] === 0);
      cursor += aligned;
    }
    requireImage(cursor === image.length);
  }
  const digest = createHash('sha256')
    .update(image.subarray(0, checksum))
    .update(image.subarray(checksum + 4, security))
    .update(image.subarray(security + 8, bodyEnd))
    .digest('hex');
  return Object.freeze({ architecture, sha256: digest, bodyBytes: bodyEnd, certificateBytes });
}
