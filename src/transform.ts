/** A 2D affine transform: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Matrix {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Composes two matrices so that applying the result = applying m1 after m2 (m1 · m2). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
    return {
        a: m1.a * m2.a + m1.c * m2.b,
        b: m1.b * m2.a + m1.d * m2.b,
        c: m1.a * m2.c + m1.c * m2.d,
        d: m1.b * m2.c + m1.d * m2.d,
        e: m1.a * m2.e + m1.c * m2.f + m1.e,
        f: m1.b * m2.e + m1.d * m2.f + m1.f,
    };
}

/** True when every coefficient matches the identity within 1e-12. */
export const isIdentity = (m: Matrix): boolean =>
    Object.entries(IDENTITY).every(([k, v]) => Math.abs(m[k as keyof Matrix] - v) < 1e-12);

/** Serializes a matrix as an SVG `matrix(a b c d e f)` transform. */
export const formatMatrix = (m: Matrix): string => `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;

export function applyPoint(m: Matrix, x: number, y: number): [number, number] {
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

/** Uniform-ish scale factor of a matrix (area-preserving), used to scale radii. */
export function scaleFactor(m: Matrix): number {
    return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

/**
 * Parses an SVG transform list (translate/scale/rotate/skewX/skewY/matrix) into one matrix.
 * Returns null when there is nothing parseable, so callers keep untransformed coordinates.
 */
export function parseTransform(transform: string | undefined): Matrix | null {
    if (!transform) return null;
    let m = IDENTITY;
    let matched = false;
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
    let fn: RegExpExecArray | null;
    while ((fn = re.exec(transform)) !== null) {
        const name = fn[1]!.toLowerCase();
        const args = fn[2]!
            .split(/[\s,]+/)
            .map(Number)
            .filter((n) => !Number.isNaN(n));
        let next: Matrix | null = null;
        switch (name) {
            case 'matrix':
                if (args.length >= 6)
                    next = { a: args[0]!, b: args[1]!, c: args[2]!, d: args[3]!, e: args[4]!, f: args[5]! };
                break;
            case 'translate':
                next = { ...IDENTITY, e: args[0] ?? 0, f: args[1] ?? 0 };
                break;
            case 'scale':
                next = { ...IDENTITY, a: args[0] ?? 1, d: args[1] ?? args[0] ?? 1 };
                break;
            case 'rotate': {
                const r = ((args[0] ?? 0) * Math.PI) / 180;
                const cos = Math.cos(r);
                const sin = Math.sin(r);
                const rot: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
                if (args.length >= 3) {
                    const cx = args[1]!;
                    const cy = args[2]!;
                    next = multiply({ ...IDENTITY, e: cx, f: cy }, multiply(rot, { ...IDENTITY, e: -cx, f: -cy }));
                } else next = rot;
                break;
            }
            case 'skewx':
                next = { ...IDENTITY, c: Math.tan(((args[0] ?? 0) * Math.PI) / 180) };
                break;
            case 'skewy':
                next = { ...IDENTITY, b: Math.tan(((args[0] ?? 0) * Math.PI) / 180) };
                break;
        }
        if (next) {
            m = multiply(m, next);
            matched = true;
        }
    }
    return matched ? m : null;
}

export interface Decomposed {
    translateX: number;
    translateY: number;
    /** degrees */
    rotation: number;
    scaleX: number;
    scaleY: number;
    /** true when the matrix has shear an Android <group> cannot represent exactly. */
    hasSkew: boolean;
}

/**
 * Decomposes a matrix into translate/rotate/scale (matching an Android `<group>`, which applies
 * scale → rotate → translate). Skew is detected and reported (not representable by a group).
 */
export function decompose(m: Matrix): Decomposed {
    const { a, b, c, d, e, f } = m;
    const scaleX = Math.hypot(a, b);
    const rotation = Math.atan2(b, a);
    const det = a * d - b * c;
    const scaleY = scaleX === 0 ? 0 : det / scaleX;
    // shear term: dot of the (normalized) X axis with the Y axis
    const shear = scaleX === 0 ? 0 : (a * c + b * d) / (scaleX * scaleX);
    return {
        translateX: e,
        translateY: f,
        rotation: (rotation * 180) / Math.PI,
        scaleX,
        scaleY,
        hasSkew: Math.abs(shear) > 1e-4,
    };
}
