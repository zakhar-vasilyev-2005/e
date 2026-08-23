

export type PromiseOrNot<T> = Promise<T> | T;
export type OrType<T extends object, P> = {
    [k in keyof T]: T[k] | P
};
export type OrUndefined<T extends object> = {
    [k in keyof T]?: T[k] | undefined
};
export type StripType<T extends object, P> = {
    [k in keyof T]: T[k] extends (infer V | P) ? V : never
};
export type StripUndefined<T extends object> = StripType<T, undefined>;
export type UnknownRecord = Record<string | symbol | number, unknown>;
export type AnyRecord = Record<string | symbol | number, any>;

export function stripUndefined<T extends object>(object: T): StripUndefined<T> {
    const result: UnknownRecord = {};
    for (const k of [...Object.getOwnPropertyNames(object), ...Object.getOwnPropertySymbols(object)]) {
        if ((object as UnknownRecord)[k] !== undefined) {
            result[k] = (object as UnknownRecord)[k];
        }
    }
    return result as any;
}
export function stripField<T extends object, K extends string | number | symbol>(object: T, key: K): Omit<T, K> {
    const result = Object.assign({}, object) as UnknownRecord;
    if (key in result) {
        delete result[key];
    }
    return result as any;
}







//