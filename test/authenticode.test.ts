import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authenticodeImage, PeImageError } from '../src/authenticode.js';

// Synthetic format controls only. Genuine CI-built/signed executables require
// the independent Windows signature/hash oracle and native launch lane as well.
function fixture(architecture: 'x86' | 'x64' | 'arm64' = 'x64'): Buffer {
  const image = Buffer.alloc(1024), pe = 128, optional = pe + 24;
  image.write('MZ'); image.writeUInt32LE(pe, 0x3c); image.write('PE\0\0', pe, 'ascii');
  image.writeUInt16LE({ x86: 0x14c, x64: 0x8664, arm64: 0xaa64 }[architecture], pe + 4);
  image.writeUInt16LE(1, pe + 6);
  image.writeUInt16LE(architecture === 'x86' ? 224 : 240, pe + 20);
  image.writeUInt16LE(architecture === 'x86' ? 0x10b : 0x20b, optional);
  image.writeUInt32LE(4096, optional + 32); image.writeUInt32LE(512, optional + 36);
  image.writeUInt32LE(8192, optional + 56); image.writeUInt32LE(512, optional + 60);
  image.writeUInt32LE(16, optional + (architecture === 'x86' ? 92 : 108));
  const section = optional + (architecture === 'x86' ? 224 : 240);
  image.write('.text', section); image.writeUInt32LE(512, section + 16); image.writeUInt32LE(512, section + 20);
  for (let i = 512; i < image.length; i++) image[i] = i % 251;
  return image;
}
const security = (architecture: string) => 152 + (architecture === 'x86' ? 96 : 112) + 32;
function withCertificate(image: Buffer, architecture = 'x64', payloadBytes = 16): Buffer {
  const length = 8 + payloadBytes, aligned = Math.ceil(length / 8) * 8;
  const signed = Buffer.concat([image, Buffer.alloc(aligned)]);
  signed.writeUInt32LE(image.length, security(architecture)); signed.writeUInt32LE(aligned, security(architecture) + 4);
  signed.writeUInt32LE(length, image.length); signed.writeUInt16LE(0x0200, image.length + 4); signed.writeUInt16LE(0x0002, image.length + 6);
  signed.fill(0x42, image.length + 8, image.length + length);
  return signed;
}
describe('bounded Authenticode image digest for canonical shipped PE layouts', () => {
  it.each(['x86', 'x64', 'arm64'] as const)('%s excludes only the prescribed header fields and certificate table', architecture => {
    const image = fixture(architecture), cert = withCertificate(image, architecture);
    // Independent, fixed fixture ranges from the PE specification, not parser output.
    const checksum = 152 + 64, directory = security(architecture);
    const expected = createHash('sha256').update(Buffer.concat([image.subarray(0, checksum), image.subarray(checksum + 4, directory), image.subarray(directory + 8)])).digest('hex');
    expect(authenticodeImage(image)).toEqual({ architecture, sha256: expected, bodyBytes: 1024, certificateBytes: 0 });
    expect(authenticodeImage(cert)).toEqual({ architecture, sha256: expected, bodyBytes: 1024, certificateBytes: 24 });
    cert.writeUInt32LE(0x87654321, checksum); cert[1032] ^= 1;
    expect(authenticodeImage(cert).sha256).toBe(expected);
    expect(Object.isFrozen(authenticodeImage(image))).toBe(true);
  });
  it.each([2, 40, 132, 200, 450, 512, 777, 1023])('detects a byte mutation outside signature exclusions at %i', offset => {
    const original = fixture(), modified = Buffer.from(original); modified[offset] ^= 1;
    try { expect(authenticodeImage(modified).sha256).not.toBe(authenticodeImage(original).sha256); }
    catch (error) { expect(error).toBeInstanceOf(PeImageError); }
  });
  it('does not mutate input or depend on an earlier caller-owned result', () => {
    const image = fixture(), before = Buffer.from(image), result = authenticodeImage(image);
    expect(image).toEqual(before); image[700] ^= 1;
    expect(authenticodeImage(image).sha256).not.toBe(result.sha256);
  });
  it('accepts two aligned certificate records without hiding any program bytes', () => {
    const image = fixture(), one = withCertificate(image);
    const two = Buffer.concat([one, one.subarray(image.length)]);
    two.writeUInt32LE(48, security('x64') + 4);
    expect(authenticodeImage(two).sha256).toBe(authenticodeImage(image).sha256);
    expect(authenticodeImage(two).certificateBytes).toBe(48);
  });
  it('hashes raw sections in physical order even when the section table is reversed', () => {
    const image = Buffer.concat([fixture(), Buffer.alloc(512, 0x71)]);
    image.writeUInt16LE(2, 134); image.writeUInt32LE(1024, 412);
    const second = 152 + 240 + 40;
    image.write('.data', second); image.writeUInt32LE(512, second + 16); image.writeUInt32LE(512, second + 20);
    const expected = createHash('sha256').update(Buffer.concat([image.subarray(0, 216), image.subarray(220, 296), image.subarray(304)])).digest('hex');
    expect(authenticodeImage(image).sha256).toBe(expected);
  });
  it.each([
    ['small image', (b: Buffer) => b.subarray(0, 300)],
    ['wrong DOS header', (b: Buffer) => { b[0] = 0; return b; }],
    ['huge PE offset', (b: Buffer) => { b.writeUInt32LE(0xffffffff, 0x3c); return b; }],
    ['bad PE signature', (b: Buffer) => { b[128] = 0; return b; }],
    ['unsupported machine', (b: Buffer) => { b.writeUInt16LE(0xffff, 132); return b; }],
    ['no sections', (b: Buffer) => { b.writeUInt16LE(0, 134); return b; }],
    ['excessive sections', (b: Buffer) => { b.writeUInt16LE(97, 134); return b; }],
    ['small optional header', (b: Buffer) => { b.writeUInt16LE(1, 148); return b; }],
    ['wrong optional magic', (b: Buffer) => { b.writeUInt16LE(0, 152); return b; }],
    ['missing security directory', (b: Buffer) => { b.writeUInt32LE(4, 260); return b; }],
    ['bad file alignment', (b: Buffer) => { b.writeUInt32LE(513, 188); return b; }],
    ['headers out of bounds', (b: Buffer) => { b.writeUInt32LE(4096, 212); return b; }],
    ['section overlaps headers', (b: Buffer) => { b.writeUInt32LE(0, 412); return b; }],
    ['section outside file', (b: Buffer) => { b.writeUInt32LE(4096, 412); return b; }],
    ['unhashed overlay', (b: Buffer) => Buffer.concat([b, Buffer.from('unapproved overlay')])],
    ['certificate size without offset', (b: Buffer) => { b.writeUInt32LE(8, 300); return b; }],
    ['certificate covers body', (b: Buffer) => { const c = withCertificate(b); c.writeUInt32LE(512, 296); return c; }],
    ['valid certificate structure hiding the whole raw section', (b: Buffer) => { b.writeUInt32LE(512, 296); b.writeUInt32LE(512, 300); b.writeUInt32LE(512, 512); b.writeUInt16LE(0x0200, 516); b.writeUInt16LE(0x0002, 518); return b; }],
    ['truncated certificate', (b: Buffer) => withCertificate(b).subarray(0, 1040)],
    ['zero certificate length', (b: Buffer) => { const c = withCertificate(b); c.writeUInt32LE(0, 1024); return c; }],
    ['oversized certificate length', (b: Buffer) => { const c = withCertificate(b); c.writeUInt32LE(0xffffffff, 1024); return c; }],
    ['wrong certificate revision', (b: Buffer) => { const c = withCertificate(b); c.writeUInt16LE(0x0100, 1028); return c; }],
    ['wrong certificate type', (b: Buffer) => { const c = withCertificate(b); c.writeUInt16LE(1, 1030); return c; }],
    ['nonzero alignment padding', (b: Buffer) => { const c = withCertificate(b, 'x64', 1); c[c.length - 1] = 1; return c; }],
    ['bytes after certificates', (b: Buffer) => Buffer.concat([withCertificate(b), Buffer.alloc(8)])],
  ])('refuses malformed %s with a fixed error', (_name, change) => {
    expect(() => authenticodeImage(change(fixture()))).toThrow(new PeImageError());
  });
  it('refuses over-limit input before copying or parsing it', () => {
    const image = Buffer.alloc(8 * 1024 * 1024 + 512);
    fixture().copy(image); image.writeUInt32LE(8 * 1024 * 1024, 408);
    expect(() => authenticodeImage(image)).toThrow(new PeImageError());
  });
  it('bounds the number of structurally valid certificate records', () => {
    const image = Buffer.concat([fixture(), Buffer.alloc(65 * 8)]);
    image.writeUInt32LE(1024, 296); image.writeUInt32LE(65 * 8, 300);
    for (let i = 0; i < 65; i++) { const at = 1024 + i * 8; image.writeUInt32LE(8, at); image.writeUInt16LE(0x0200, at + 4); image.writeUInt16LE(0x0002, at + 6); }
    expect(() => authenticodeImage(image)).toThrow(new PeImageError());
  });
});
