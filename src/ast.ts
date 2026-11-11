/** An element (or text / comment node) of svgo's AST (xast), reduced to what the converter reads. */
export interface XastElement {
    type: string;
    name?: string;
    attributes?: Record<string, string>;
    children?: XastElement[];
}

/** The document node svgo hands to its plugins. */
export interface XastRoot {
    type: 'root';
    children: XastElement[];
}

/** Size of the viewport percentages resolve against. */
export interface Viewport {
    width: number;
    height: number;
}

/** An axis-aligned bounding box in user space. */
export interface BBox {
    x: number;
    y: number;
    width: number;
    height: number;
}
