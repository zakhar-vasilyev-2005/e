import * as koffi from 'koffi';




export interface VectorNormalizer {
    normalize(vector: number[] | Float32Array, multiplier?: number): Float32Array;
}

export class VectorNormalizerLib {
    public readonly lib: koffi.LibraryHandle;
    public constructor(library: string) {
        this.lib = koffi.load(library);
    }
    public normalize(vector: number[] | Float32Array, multiplier?: number) {
        const buffer = new Float32Array(vector);
        this.lib.func("v_normalize", "float*", [koffi.inout("float*"), "size_t", "float"])(buffer, buffer.length, multiplier ?? 1);
        return buffer;
    }
}




