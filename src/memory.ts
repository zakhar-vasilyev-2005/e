import fs from 'fs-extra';
import path from 'path';
import { getFileTree } from './get-file-tree.js';
import * as YAML from 'yaml';



export const KEYS_SECTION_TITLE = "Recall keys";
export const KEYS_SECTION_KEY_TITLE = (n: number) => `Key ${n}`;
export const CONTENT_SECTION_TITLE = {
    fact: "Information",
    rule: "Instruction",
    task: "Task body",
};

export type MemoKey = {
    weight: number,
    weightFixed: boolean,
    keyContent: string,
};
export type MemoContent = {
    type: "fact" | "rule";
    dependencies?: never,
    failures?: never,
    keys: MemoKey[];
    briefly: string;
    body: string;
} | {
    type: "task";
    dependencies: `${string}.md`[];
    failures: number,
    keys?: never;
    briefly: string;
    body: string;
};
export type Memo = {
    file: `/${string}.md`,
    name: `${string}.md`,
    content: MemoContent,
    mtime: Date,
};

export class MemoDB {
    public static async load(dir: string) {
        await fs.ensureDir(dir);
        const tree = await getFileTree(dir);
        const memories = (await Promise.all(tree.map(async file => {
            if (/^[\s\S]*\.(fact|rule|task)\.md$/.exec(file) === null) { return []; }
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
        const memo: Memo = Object.freeze({
            file: file as any,
            name: name as any,
            content: Object.freeze(content),
            mtime,
        });
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
        type: "fact",
        keys: [],
        briefly: "",
        body: "",
    };
}
export function stringifyMemo(content: MemoContent): string {
    let header = content.type === "task" ? {
        type: content.type,
        description: content.briefly,
        dependencies: content.dependencies,
        failures: content.failures,
    } : {
        type: content.type,
        description: content.briefly,
        key_weights: Object.fromEntries((content.keys ?? []).map(
            (e, i) => [KEYS_SECTION_KEY_TITLE(i + 1), e.weightFixed ? `fixed ${e.weight}` : `${e.weight}`]
        )),
    };
    return [
        `---\n${YAML.stringify(header).trim()}\n---\n# ${content.briefly}`,
        `## ${CONTENT_SECTION_TITLE[content.type]}\n${content.body.trim()}`,
        ...(content.keys?.length === 0 ? [] : [
            `## ${KEYS_SECTION_TITLE}\n` + (content.keys ?? []).map((e, i) => `### ${KEYS_SECTION_KEY_TITLE(i + 1)}\n${e.keyContent.trim()}`).join("\n")
        ]),
    ].join("\n");
}






