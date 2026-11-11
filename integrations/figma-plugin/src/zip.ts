// Minimal ZIP writer (PKWARE APPNOTE 6.3): "stored" entries only (no compression), no ZIP64.
// Enough for a handful of small XML files, without adding a dependency to the plugin.

export interface ZipEntry {
    /** Path inside the archive, `/`-separated (e.g. `drawable/ic_arrow.xml`). */
    path: string;
    data: Uint8Array | string;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** CRC-32 (IEEE 802.3), as ZIP and gzip use it. */
export function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date fields (local time, 2 s resolution, years 1980–2107). */
function dosDateTime(date: Date): { time: number; date: number } {
    const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

/** Bit 11 of the general purpose flags: file names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20; // 2.0: the baseline every unzip tool reads
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

/**
 * Builds a ZIP archive of `entries`, stored without compression. Throws on duplicate or empty
 * paths and on archives that would need ZIP64 (more than 65535 entries or 4 GiB).
 */
export function createZip(entries: readonly ZipEntry[], modified: Date = new Date()): Uint8Array {
    if (entries.length > MAX_UINT16) throw new RangeError('Too many files for a ZIP archive without ZIP64.');
    const encoder = new TextEncoder();
    const { time, date } = dosDateTime(modified);
    const seen = new Set<string>();
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
        if (!entry.path || entry.path.startsWith('/') || entry.path.split('/').includes('..'))
            throw new Error(`Invalid path in ZIP archive: "${entry.path}"`);
        if (seen.has(entry.path)) throw new Error(`Duplicate path in ZIP archive: ${entry.path}`);
        seen.add(entry.path);
        const name = encoder.encode(entry.path);
        const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
        const crc = crc32(data);

        const local = new Uint8Array(30 + name.length + data.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true); // local file header signature
        lv.setUint16(4, VERSION_NEEDED, true);
        lv.setUint16(6, FLAG_UTF8, true);
        lv.setUint16(8, 0, true); // method: stored
        lv.setUint16(10, time, true);
        lv.setUint16(12, date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true); // compressed size
        lv.setUint32(22, data.length, true); // uncompressed size
        lv.setUint16(26, name.length, true);
        lv.setUint16(28, 0, true); // extra field length
        local.set(name, 30);
        local.set(data, 30 + name.length);

        const central = new Uint8Array(46 + name.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true); // central directory header signature
        cv.setUint16(4, VERSION_NEEDED, true); // version made by (MS-DOS, 2.0)
        cv.setUint16(6, VERSION_NEEDED, true);
        cv.setUint16(8, FLAG_UTF8, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true);
        // 30 extra length, 32 comment length, 34 disk number, 36 internal attributes, 38 external
        // attributes: all zero.
        cv.setUint32(42, offset, true); // offset of the local header
        central.set(name, 46);

        locals.push(local);
        centrals.push(central);
        offset += local.length;
        if (offset > MAX_UINT32) throw new RangeError('ZIP archive too large without ZIP64.');
    }

    const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); // end of central directory signature
    ev.setUint16(8, entries.length, true); // entries on this disk
    ev.setUint16(10, entries.length, true); // entries in total
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true); // offset of the central directory

    const out = new Uint8Array(offset + centralSize + end.length);
    let at = 0;
    for (const part of [...locals, ...centrals, end]) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
