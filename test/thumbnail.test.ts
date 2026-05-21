import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { compressThumbToJpeg, isGifThumb, isThumbName } from '../src/lib/thumbnail.js';

describe('isThumbName', () => {
  it('matches thumb.{png,jpg,jpeg,webp,gif} case-insensitively', () => {
    for (const n of ['thumb.png', 'thumb.jpg', 'thumb.jpeg', 'thumb.webp', 'thumb.gif', 'THUMB.PNG']) {
      expect(isThumbName(n)).toBe(true);
    }
  });
  it('does not match non-thumb names', () => {
    for (const n of ['thumbnail.png', 'thumb.svg', 'hero.png', 'thumb.txt', 'mythumb.png']) {
      expect(isThumbName(n)).toBe(false);
    }
  });
});

describe('isGifThumb', () => {
  it('detects gif extension', () => {
    expect(isGifThumb('thumb.gif')).toBe(true);
    expect(isGifThumb('thumb.GIF')).toBe(true);
    expect(isGifThumb('thumb.png')).toBe(false);
  });
});

describe('compressThumbToJpeg', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zuroku-thumb-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('converts a PNG to JPEG named thumb.jpg', async () => {
    const src = path.join(dir, 'thumb.png');
    await sharp({ create: { width: 100, height: 60, channels: 3, background: '#5e6ad2' } })
      .png()
      .toFile(src);

    const out = await compressThumbToJpeg(src);
    expect(out.filename).toBe('thumb.jpg');
    expect(out.contentType).toBe('image/jpeg');
    // JPEG SOI magic bytes
    expect(out.buffer[0]).toBe(0xff);
    expect(out.buffer[1]).toBe(0xd8);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('downscales so the long edge is <= maxLongEdge', async () => {
    const src = path.join(dir, 'big.png');
    await sharp({ create: { width: 4000, height: 1000, channels: 3, background: '#fff' } })
      .png()
      .toFile(src);

    const out = await compressThumbToJpeg(src, { maxLongEdge: 2000 });
    const meta = await sharp(out.buffer).metadata();
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(500);
  });
});
