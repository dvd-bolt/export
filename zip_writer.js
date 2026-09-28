/**
 * Gemini Chat Exporter — Minimal ZIP Writer
 * STORE mode (no compression). No external dependencies.
 * Compatible with Chrome Extension Service Workers.
 */

// eslint-disable-next-line no-var
var ZIP_WRITER = (() => {
  // ── CRC-32 ──────────────────────────────────────────────────────────────────
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ── Buffer helpers ───────────────────────────────────────────────────────────
  function u16(buf, off, v) {
    buf[off]     =  v        & 0xFF;
    buf[off + 1] = (v >>> 8) & 0xFF;
  }

  function u32(buf, off, v) {
    buf[off]     =  v         & 0xFF;
    buf[off + 1] = (v >>> 8)  & 0xFF;
    buf[off + 2] = (v >>> 16) & 0xFF;
    buf[off + 3] = (v >>> 24) & 0xFF;
  }

  const ENC = new TextEncoder();

  // ── Public API ───────────────────────────────────────────────────────────────
  /**
   * Build a ZIP archive.
   * @param {Array<{name: string, content: string}>} files
   * @returns {Uint8Array}
   */
  function createZip(files) {
    // Pre-encode all file names and content
    const entries = files.map(f => {
      const nameBytes = ENC.encode(f.name);
      const dataBytes = ENC.encode(f.content);
      return { nameBytes, dataBytes, crc: crc32(dataBytes) };
    });

    // Calculate total buffer size
    const LFH = 30; // Local File Header fixed size
    const CDH = 46; // Central Dir Header fixed size
    const EOCD = 22;

    let size = EOCD;
    for (const e of entries) {
      size += LFH + e.nameBytes.length + e.dataBytes.length;
      size += CDH + e.nameBytes.length;
    }

    const buf = new Uint8Array(size);
    let pos = 0;
    const offsets = [];

    // ── Local file headers + data ──────────────────────────────────────────────
    for (const e of entries) {
      offsets.push(pos);
      const len = e.dataBytes.length;

      buf[pos++]=0x50; buf[pos++]=0x4B; buf[pos++]=0x03; buf[pos++]=0x04; // signature
      u16(buf, pos, 20);    pos += 2; // version needed
      u16(buf, pos, 0x0800); pos += 2; // flags (UTF-8 filename encoding)
      u16(buf, pos, 0);     pos += 2; // compression: STORE
      u16(buf, pos, 0);     pos += 2; // mod time
      u16(buf, pos, 0);     pos += 2; // mod date
      u32(buf, pos, e.crc); pos += 4; // crc-32
      u32(buf, pos, len);   pos += 4; // compressed size
      u32(buf, pos, len);   pos += 4; // uncompressed size
      u16(buf, pos, e.nameBytes.length); pos += 2; // filename length
      u16(buf, pos, 0);     pos += 2; // extra field length

      buf.set(e.nameBytes, pos); pos += e.nameBytes.length;
      buf.set(e.dataBytes, pos); pos += e.dataBytes.length;
    }

    // ── Central directory ──────────────────────────────────────────────────────
    const cdStart = pos;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const len = e.dataBytes.length;

      buf[pos++]=0x50; buf[pos++]=0x4B; buf[pos++]=0x01; buf[pos++]=0x02; // signature
      u16(buf, pos, 20);         pos += 2; // version made by
      u16(buf, pos, 20);         pos += 2; // version needed
      u16(buf, pos, 0x0800);     pos += 2; // flags (UTF-8 filename encoding)
      u16(buf, pos, 0);          pos += 2; // compression
      u16(buf, pos, 0);          pos += 2; // time
      u16(buf, pos, 0);          pos += 2; // date
      u32(buf, pos, e.crc);      pos += 4; // crc-32
      u32(buf, pos, len);        pos += 4; // compressed size
      u32(buf, pos, len);        pos += 4; // uncompressed size
      u16(buf, pos, e.nameBytes.length); pos += 2; // filename length
      u16(buf, pos, 0);          pos += 2; // extra field length
      u16(buf, pos, 0);          pos += 2; // comment length
      u16(buf, pos, 0);          pos += 2; // disk number start
      u16(buf, pos, 0);          pos += 2; // internal attrs
      u32(buf, pos, 0);          pos += 4; // external attrs
      u32(buf, pos, offsets[i]); pos += 4; // offset of local header
      buf.set(e.nameBytes, pos); pos += e.nameBytes.length;
    }

    // ── End of Central Directory ───────────────────────────────────────────────
    const cdSize = pos - cdStart;

    buf[pos++]=0x50; buf[pos++]=0x4B; buf[pos++]=0x05; buf[pos++]=0x06; // signature
    u16(buf, pos, 0);               pos += 2; // disk number
    u16(buf, pos, 0);               pos += 2; // start disk
    u16(buf, pos, entries.length);  pos += 2; // entries on disk
    u16(buf, pos, entries.length);  pos += 2; // total entries
    u32(buf, pos, cdSize);          pos += 4; // central dir size
    u32(buf, pos, cdStart);         pos += 4; // central dir offset
    u16(buf, pos, 0);               pos += 2; // comment length

    return buf;
  }

  return { createZip };
})();
