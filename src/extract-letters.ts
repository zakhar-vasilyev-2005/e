


export function extractLetters(s: string): string {
    return s.toLowerCase().matchAll(/\p{L}/gu).toArray().join("");
}