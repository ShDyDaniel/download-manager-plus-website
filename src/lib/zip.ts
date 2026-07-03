/**
 * Minimal ZIP builder — STORE only (no compression), assembled fully
 * in memory. Used by the admin panel to package the sync-telemetry
 * export (fingerprints are already gzipped, XMLs/JSONs are small, so
 * compressing again buys nothing and a dependency-free writer keeps
 * the bundle light). Names are written with the UTF-8 flag set.
 */

export interface ZipEntry {
  name: string
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const name = encoder.encode(e.name)
    const crc = crc32(e.data)
    const size = e.data.length

    // Local file header
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true)
    lh.setUint16(4, 20, true) // version needed
    lh.setUint16(6, 0x0800, true) // flags: UTF-8 names
    lh.setUint16(8, 0, true) // method: STORE
    lh.setUint16(10, 0, true) // mod time
    lh.setUint16(12, 0, true) // mod date
    lh.setUint32(14, crc, true)
    lh.setUint32(18, size, true) // compressed
    lh.setUint32(22, size, true) // uncompressed
    lh.setUint16(26, name.length, true)
    lh.setUint16(28, 0, true) // extra len
    parts.push(new Uint8Array(lh.buffer), name, e.data)

    // Central directory record
    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true) // version made by
    cd.setUint16(6, 20, true) // version needed
    cd.setUint16(8, 0x0800, true)
    cd.setUint16(10, 0, true)
    cd.setUint16(12, 0, true)
    cd.setUint16(14, 0, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, size, true)
    cd.setUint32(24, size, true)
    cd.setUint16(28, name.length, true)
    // extra/comment/disk/attrs all zero
    cd.setUint32(42, offset, true) // local header offset
    central.push(new Uint8Array(cd.buffer), name)

    offset += 30 + name.length + size
  }

  let cdSize = 0
  for (const c of central) cdSize += c.length

  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, cdSize, true)
  end.setUint32(16, offset, true) // central dir offset
  parts.push(...central, new Uint8Array(end.buffer))

  return new Blob(parts as BlobPart[], { type: 'application/zip' })
}
