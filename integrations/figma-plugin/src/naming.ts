// Android resource names for the selected layers: the library's `androidResourceName`, plus a
// numeric suffix when two layers map to the same name (a zip cannot hold two `drawable/x.xml`).
import { androidResourceName } from '../../../src/resourceName.ts';

/**
 * One valid, distinct Android resource name per layer name, in input order.
 *
 * The first layer of a group of duplicates keeps the plain name; the next ones get `_2`, `_3`…,
 * skipping any suffixed name that another layer produces on its own, so `["Arrow", "arrow",
 * "arrow_2"]` gives `["arrow", "arrow_3", "arrow_2"]`: no layer loses the name it asked for.
 */
export function uniqueResourceNames(layerNames: readonly string[]): string[] {
    const baseNames = layerNames.map((name) => androidResourceName(name));
    const reserved = new Set(baseNames);
    const used = new Set<string>();
    return baseNames.map((base) => {
        let name = base;
        if (used.has(name)) {
            let suffix = 2;
            while (reserved.has(`${base}_${suffix}`) || used.has(`${base}_${suffix}`)) suffix++;
            name = `${base}_${suffix}`;
        }
        used.add(name);
        return name;
    });
}
