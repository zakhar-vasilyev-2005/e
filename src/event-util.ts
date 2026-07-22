import type { EventEmitter } from "events";


export function createFreeEvent<T extends EventEmitter, R>(eventName: string, cb: (ths: T) => R) {
    let hasFreed = false;
    return function free(this: T) {
        if (hasFreed) { return; }
        hasFreed = true;
        const result = cb(this);
        if (result instanceof Promise) {
            return result.then(value => {
                this.emit(eventName);
                return value;
            }) as typeof result;
        } else {
            this.emit(eventName);
            return result;
        }
    }
}
export function createEvent<T extends EventEmitter, R>(eventName: string, cb: (ths: T) => R) {
    return function free(this: T) {
        const result = cb(this);
        if (result instanceof Promise) {
            return result.then(value => {
                this.emit(eventName);
                return value;
            }) as typeof result;
        } else {
            this.emit(eventName);
            return result;
        }
    }
}


//