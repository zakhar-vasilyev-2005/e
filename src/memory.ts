import fs from 'fs-extra';
import path from 'path';
import { getFileTree } from './get-file-tree.js';




export type MemoKey = {
    weight: number,
    weightFixed: boolean,
    keyContent: string,
};
export type MemoContent = {
    keys: MemoKey[],
    briefly: string,
    body: string,
};
export type Memo = {
    file: string,
    name: string,
    content: MemoContent,
    mtime: Date,
};

export class MemoDB {
    public static async load(dir: string) {
        await fs.ensureDir(dir);
        const tree = await getFileTree(dir);
        const memories = (await Promise.all(tree.map(async file => {
            if (!file.endsWith(".memo.md")) { return []; }
            try {
                return [await readMemo(dir, file)];
            } catch (e) {
                await fs.rename(file, file + ".error")
                return [];
            }
        }))).flat();
        return new MemoDB(dir, memories);
    }
    public constructor(public readonly dir: string, protected memories: Memo[] = []) { }
    public async addMemo(content: MemoContent, name: string) {
        const file = path.join(this.dir, name);
        await fs.writeFile(stringifyMemo(content), file, { encoding: "utf-8" });
        const mtime = (await fs.stat(file)).mtime
        const memo = Object.freeze({ file, name, content: Object.freeze(content), mtime });
        this.memories.push(memo);
        return memo;
    }
    public getMemo(name: string) {
        return this.memories.find(e => e.name === name);
    }
    public getMemos() {
        return [...this.memories];
    }
    public async removeMemo(name: string) {
        const memo = this.memories.find(e => e.name === name);
        this.memories = this.memories.filter(e => e.name !== name);
        if (memo !== undefined) {
            await fs.unlink(memo.file);
        }
        return memo;
    }
}

export async function readMemo(dir: string, file: string) {
    const content = await fs.readFile(file, { encoding: "utf-8" });
    return Object.freeze({
        file,
        name: file.slice(dir.length).match(/^\/?([\s\S]*)$/)?.[1] ?? "",
        content: Object.freeze(parseMemo(content)),
        mtime: (await fs.stat(file)).mtime,
    }) as Memo;
}
export function parseMemo(s: string): MemoContent {
    throw new Error("not implemented");
    return {
        keys: [],
        briefly: "",
        body: "",
    };
}
export function stringifyMemo(content: MemoContent): string {
    throw new Error("not implemented");
    return "";
}






