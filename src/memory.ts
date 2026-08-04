import fs from 'fs-extra';
import path from 'path';
import { getFileTree } from './get-file-tree.js';
import matter from 'gray-matter';
import { parse as parseMarkdown } from 'marked';
import TurndownService from 'turndown';
import * as z from 'zod';
import * as cheerio from 'cheerio';
import { extractLetters } from './extract-letters.js';



export const KEYS_SECTION_TITLE = "Recall keys"; // no special characters in terms of markdown and xmlselector's string values
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
            if (/^[\s\S]*\.md$/.exec(file) === null) { return []; }
            try {
                return [await readMemo(dir, file)];
            } catch (e) {
                await fs.rename(file, file + ".error")
                console.error(e);
                return [];
            }
        }))).flat();
        return new MemoDB(dir, memories);
    }
    public constructor(public readonly dir: string, protected memories: Memo[] = []) { }
    public async addMemo(content: MemoContent, name: string) {
        const file = path.join(this.dir, name);
        await fs.ensureDir(path.dirname(file));
        await fs.writeFile(file, stringifyMemo(content), { encoding: "utf-8" });
        const mtime = (await fs.stat(file)).mtime;
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
    const { content: fullContent, data: rawHeader } = matter(s);
    const header = z.parse(MemoStringHeaderScheme, rawHeader);
    const { keys, body } = (() => {
        const $ = cheerio.load(parseMarkdown(fullContent, { async: false }));
        const turndownService = new TurndownService({
            headingStyle: "atx",
            bulletListMarker: "-",
            codeBlockStyle: "fenced",
            fence: "```",
            emDelimiter: "*",
            strongDelimiter: "**",
            linkStyle: "inlined",
            linkReferenceStyle: "full",
            hr: "---",
        });
        const bodyHeader = $("h2").filter((i, e) => extractLetters($(e).text()) === extractLetters(CONTENT_SECTION_TITLE[header.type]))
        const bodyHtml = $(bodyHeader).nextUntil("h1,h2").toString();
        const body = turndownService.turndown(bodyHtml);
        if (header.type === "task") {
            return { keys: [], body };
        }
        const sectionHeader = $(`h2`).filter((i, el) => extractLetters($(el).text()) === extractLetters(KEYS_SECTION_TITLE));
        const headers = $(sectionHeader).nextUntil("h2,h1").filter((i, e) => e.tagName === "h3").toArray();
        const weights = Object.fromEntries(Object.entries(header.key_weights)
            .map(([k, v]) => [extractLetters(k), /^(fixed\s*)?([\s\S]*)$/.exec(String(v))] as [string, RegExpExecArray])
            .map(([k, v]) => [k, v[1] ? { fixed: true, weight: parseFloat(v[2] ?? "") } : { fixed: true, weight: parseFloat(v[2] ?? "") }])
        )
        const keys = headers.map(key => {
            const { weight, fixed } = weights[extractLetters($(key).text())] ?? { fixed: false, weight: 1.0 };
            const contentHtml = $(key).nextUntil("h3,h2,h1").toString();
            const content = turndownService.turndown(contentHtml);
            return { keyContent: content, weight, weightFixed: fixed } as MemoKey;
        });
        return { keys, body };
    })();
    return header.type === "task" ? {
        type: header.type,
        briefly: header.description,
        dependencies: header.dependencies as any[],
        failures: header.failures,
        body,
    } : {
        type: header.type,
        keys,
        briefly: header.description,
        body,
    };
}
export const MemoStringHeaderScheme = z.discriminatedUnion("type", [
    z.object({
        type: z.enum(["rule", "fact"]),
        description: z.string(),
        key_weights: z.record(z.string(), z.union([z.string(), z.number()]))
    }),
    z.object({
        type: z.literal("task"),
        description: z.string(),
        dependencies: z.array(z.string()),
        failures: z.int().nonnegative(),
    })
]);
export type MemoStringHeader = z.output<typeof MemoStringHeaderScheme>;
export function generateHeader(content: MemoContent): MemoStringHeader {
    return content.type === "task" ? {
        type: content.type,
        description: content.briefly,
        dependencies: content.dependencies,
        failures: content.failures,
    } : {
        type: content.type,
        description: content.briefly,
        key_weights: Object.fromEntries((content.keys ?? []).map(
            (e, i) => [KEYS_SECTION_KEY_TITLE(i + 1), e.weightFixed ? `fixed ${e.weight}` : e.weight]
        )),
    };
}
export function stringifyMemo(content: MemoContent): string {
    const text = [
        `## ${CONTENT_SECTION_TITLE[content.type]}\n${content.body.trim()}\n`,
        ...(content.keys?.length === 0 ? [] : [
            `## ${KEYS_SECTION_TITLE}`, ...(content.keys ?? []).map((e, i) => `### ${KEYS_SECTION_KEY_TITLE(i + 1)}\n${e.keyContent.trim()}`)
        ]),
    ].join("\n");
    return matter.stringify({ content: text }, generateHeader(content));
}







