import EventEmitter from 'events';
import { ClientLine, ModelClient, ModelLine, ModelParamsSchema, SamplerConstructorScheme, type ContentElem, type PullResult, type SamplerConstructor } from 'u-llm-server';
import { createFreeEvent } from './event-util.js';
import { Yurandom } from 'yurandom/index.js';
import { Embedder, getModels, type EmbedderCreateParams, type GetModelEntry } from './embedder.js';
import { Index, MetricKind, ScalarKind, type IndexConfig } from 'usearch';
import path from 'path';
import fs from 'fs-extra';
import { MemoDB, readMemo, type Memo, type MemoContent } from './memory.js';
import z from 'zod';
import { getFileTree } from './get-file-tree.js';
import { VectorNormalizerLib, type VectorNormalizer } from './vector-normalizer.js';
import { readConfig } from './config.js';
import { sprintf } from 'sprintf-js';





export type RecallQuery = {
    query: string
    name?: never;
} | {
    query?: never;
    name: string
};
export type AgentEvents = { close: [] };
export type AgentParams = {
    activeFolder: string,
    modelClient: ModelClient,
    embedder: Embedder,
    vectorIndexFile: string,
    vectorIndex: Index,
    memory: MemoDB,
    memoryIdsFile: string,
    memoryIds: Record<string, string>,
    rng: Yurandom,
    vectorNormalizer: VectorNormalizer,
    taskSamplerMain: SamplerConstructor,
    tags: MainParams["tags"],
    patterns: {
        systemPrompt: string,
        task: string,
        taskDependencies: string,
        taskDependenciesEntry: string,
        recallSelector: string,
        recallSelectorRuleEntry: string,
        recallSelectorFactEntry: string,
        recallSelectorTaskEntry: string,
        recallResult: string,
        recallResultFactEntry: string,
        recallResultRuleEntry: string,
        recallResultTaskEntry: string,
        taskGrammarMain: string,
    },
    numbers: MainParams["numbers"],
}
export class Agent extends EventEmitter<AgentEvents> implements AgentParams {
    public readonly activeFolder: string;
    public readonly modelClient: ModelClient;
    public readonly embedder: Embedder;
    public readonly vectorIndexFile: string;
    public readonly vectorIndex: Index;
    public memoryIndexSaveLoopRunning: boolean = false;
    public readonly memory: MemoDB;
    public readonly memoryIdsFile: string;
    public readonly memoryIds: Record<string, string>;
    public readonly memoryIdsForName: Record<string, string[]>;
    public readonly rng: Yurandom;
    public readonly vectorNormalizer: VectorNormalizer;
    public readonly taskSamplerMain: SamplerConstructor;
    public readonly taskGrammarMain: string;
    public readonly tags: MainParams["tags"];
    public readonly patterns: AgentParams["patterns"];
    public readonly numbers: MainParams["numbers"];
    public constructor(params: AgentParams) {
        super();
        this.activeFolder = params.activeFolder;
        this.modelClient = params.modelClient;
        this.embedder = params.embedder;
        this.vectorIndexFile = params.vectorIndexFile;
        this.vectorIndex = params.vectorIndex;
        this.memory = params.memory;
        this.memoryIdsFile = params.memoryIdsFile;
        this.memoryIds = params.memoryIds;
        this.memoryIdsForName = {};
        for (const id in this.memoryIds) {
            const name = this.memoryIds[id] as string;
            this.memoryIdsForName[name] = [...(this.memoryIdsForName[id] ?? []), id];
        }
        this.rng = params.rng;
        this.vectorNormalizer = params.vectorNormalizer;
        this.taskSamplerMain = params.taskSamplerMain;
        this.taskGrammarMain = sprintf(params.patterns.taskGrammarMain, {
            tags: params.tags,
            patterns: {
                think_content: "( " + [...("</" + params.tags.think + ">")].map((c, i, a) => a.slice(0, i + 1).join("")).map(tag => {
                    const last = [...tag][tag.length - 1];
                    const charClass = `[^${"]\\".includes(last ?? "-") ? "\\" : ""}${last ?? ""}]`;
                    return tag.length === 1 ? charClass : [`"${tag.slice(0, -1).replaceAll("\\", "\\\\").replaceAll("\"", "\\")}" ${charClass}`];
                }).join(" | ") + ")+"
            }
        });
        this.tags = params.tags;
        this.patterns = params.patterns;
        this.numbers = params.numbers;
    }
    public beforeRecall: Promise<void>[] = [];
    public async findMemos(query: RecallQuery, maxCount: number = 5, minDistance: number = 0): Promise<{ memo: Memo, distance: number }[]> {
        if (query.name !== undefined) {
            const memo = this.memory.getMemo(query.name);
            return memo === undefined ? [] : [{ memo, distance: 1 }];
        }
        if (this.beforeRecall.length !== 0) {
            await Promise.all(this.beforeRecall);
            this.beforeRecall = [];
        }
        const rawQueryVector = Float32Array.from(await this.embedder.embedding(query.query));
        const queryVector = this.vectorNormalizer.normalize(rawQueryVector, 1);
        const result = this.vectorIndex.search(queryVector, maxCount, this.numbers.vectorIndexThreads);
        const toDelete: bigint[] = [];
        const memories: { memo: Memo, distance: number }[] = [];
        for (let i = 0; i < maxCount; i++) {
            const vectorId = result.keys[i];
            const distance = result.distances[i];
            if (vectorId === undefined || distance === undefined) {
                continue;
            }
            const name = this.memoryIds[String(vectorId)];
            if (name === undefined) {
                toDelete.push(vectorId);
            } else {
                const memo = this.memory.getMemo(name);
                if (memo === undefined) {
                    toDelete.push(vectorId);
                    delete this.memoryIds[String(vectorId)];
                    delete this.memoryIdsForName[name];
                } else {
                    memories.push({ memo, distance });
                }
            }
        }
        this.vectorIndex.remove(toDelete);
        if (toDelete.length !== 0) {
            return await this.findMemos(query, maxCount);
        }
        return memories.filter(e => e.distance >= minDistance);
    }
    public async addMemo(content: MemoContent, name: `${string}.md`) {
        if (this.memory.getMemo(name) !== undefined) {
            await this.removeMemo(name);
        }
        const memo = await this.memory.addMemo(content, name);
        const keys = content.keys ?? [];
        const idsAndWeights = keys.map(({ weight }) => {
            let id: bigint;
            while (true) {
                id = BigInt(this.rng.int(100, 1_000_000_000));
                if (!(String(id) in this.memoryIds)) {
                    break;
                }
            }
            this.memoryIds[String(id)] = name;
            this.memoryIdsForName[name] ??= [];
            this.memoryIdsForName[name].push(String(id));
            return { id, weight };
        });
        const ids = idsAndWeights.map(e => e.id);
        if (keys.length !== 0) {
            const weights = idsAndWeights.map(e => e.weight);
            const vectors = new Float32Array(keys.length * this.vectorIndex.dimensions());
            const vectorsRaw = await this.embedder.embeddingBatched(keys.map(e => e.keyContent));
            let offset = 0;
            for (const vec of vectorsRaw) {
                const multiplier = weights.pop();
                if (multiplier === undefined) { throw new Error(`unexpected situation: mismatch in weights count and embeddings count`); }
                const normalizedVec = this.vectorNormalizer.normalize(vec, multiplier);
                vectors.set(normalizedVec, offset);
                offset += vec.length;
            }
            this.vectorIndex.add(ids, vectors);
        }
        return memo;
    }
    public async removeMemo(name: `${string}.md`) {
        await this.memory.removeMemo(name);
        const ids = this.memoryIdsForName[name] ?? [];
        delete this.memoryIdsForName[name];
        for (const id of ids) {
            delete this.memoryIds[id];
        }
    }
    public async updateMemoryIndex() {
        this.vectorIndex.save(this.vectorIndexFile);
        await fs.writeJson(this.memoryIdsFile, this.memoryIds, { encoding: "utf-8" });
    }
    public async run() {
        const vectorIndexMtimeMs = (await fs.stat(this.vectorIndexFile)).mtimeMs;
        const initialMemories = Object.fromEntries(this.memory.getMemos().map(e => [e.file, e]));
        await Promise.all((await getFileTree(this.memory.dir)).map(async file => {
            const memo = initialMemories[file];
            if (memo === undefined || memo.mtime.getTime() >= vectorIndexMtimeMs) {
                const loadedMemo = await readMemo(this.memory.dir, file);
                this.addMemo(loadedMemo.content, loadedMemo.name);
                return;
            }
        }));
        const memoryIndexSaveLoop = async () => {
            await this.updateMemoryIndex();
            if (this.memoryIndexSaveLoopRunning) {
                setTimeout(memoryIndexSaveLoop, this.numbers.memoryIndexSaveInterval);
            }
        };
        this.memoryIndexSaveLoopRunning = true;
        memoryIndexSaveLoop();
        try {
            await this.main();
        } catch (e) {
            console.error(e);
        } finally {
            this.memoryIndexSaveLoopRunning = false;
            await this.close();
        }
    }
    public async main() {
        const lines = await this.modelClient.exec("line_list", null);
        await Promise.all(lines.map(e => { this.modelClient.exec("line_free", { line_id: e.line_id }) }));
        console.log("CONNECTED");
        await this.runTask((await this.addMemo({
            body: "Do something.",
            briefly: "Short task.",
            type: "task",
            dependencies: [],
            failures: 0,
        }, "temp/short-task.md")).content as any);
    }
    public async findLineId() {
        let lineId: string;
        while (true) {
            lineId = `task_${this.rng.hex(3)}`;
            const lines = await this.modelClient.exec("line_list", null);
            if (!lines.some(e => e.line_id === lineId)) {
                return lineId;
            }
        }
    }
    public async runTask(task: MemoContent & { type: "task" }) {
        const pre = this.modelClient.prefixes;
        const taskText = await this.formatTask(task);
        const line = await ClientLine.create(this.modelClient, await this.findLineId(), this.taskSamplerMain);
        this.modelClient.on("tokens", e => {
            if (e.line_id === line.lineId) {
                process.stdout.write(e.input.map(e => e.piece).join(""));
            }
        });
        await line.clear();
        const systemPrompt = sprintf(this.patterns.systemPrompt, {
            tags: this.tags,
            date: new Date(),
        });
        const p1 = await line.step(pre.initToSystem, systemPrompt, pre.systemToUser, taskText);
        const memories = (await this.findMemos({ query: taskText }, this.numbers.recallMaxMemories)).map(e => e.memo.content);
        const grammarIndices = (indices: number[]): string => {
            if (indices.length === 0) {
                throw new Error(`bad argument for grammarIndices: indices length must be >= 1`);
            } else if (indices.length === 1) {
                return `"${indices[0]}"`;
            } else {
                return `( "${indices[0]}" | "${indices[0]}" "," [ ]* ${grammarIndices(indices.slice(1))} )`;
            }
        }
        let selectedMemories: MemoContent[];
        if (memories.length === 0) {
            selectedMemories = [];
        } else {
            const grammar = `root ::= "<${this.tags.select_memories}>" [ ]* ( "none" | ${grammarIndices(memories.map((e, i) => i + 1))} ) [ ]* "</${this.tags.select_memories}>"`;
            const p2 = await line.step(
                await this.formatRecallSelector(memories),
                pre.userToAssistant
            );
            await line.setSampler([
                { type: "grammar", grammar, root: "root" },
                { type: "dist", seed: this.rng.int(0, 32000) },
            ], line.tokens.length);
            while (true) {
                await line.push(`<${this.tags.select_memories}>`);
                const res = await line.pull({
                    eog_stop: true,
                    max_tokens: this.numbers.recallSelectorMaxTokens,
                });
                if (res.stopReasons.some(e => e === "max_tokens")) {
                    await line.goto(p2);
                    continue;
                } else {
                    let selectedIds: number[];
                    const m = new RegExp(`^<${this.tags.select_memories}>\\s*(none|(\\d+,\\s*)*\\d+)\\s*</${this.tags.select_memories}>$`, "u").exec(res.text ?? "");
                    const answer = m?.[0];
                    if (typeof answer !== "string") {
                        throw new Error(`recall selector broken: cannot extract answer`);
                    }
                    if (answer.trim() === "none") {
                        selectedIds = [];
                    } else {
                        selectedIds = answer.split(",").map(e => parseInt(e.matchAll(/\d/g).toArray().join("")));
                    }
                    selectedMemories = memories.filter((e, i) => selectedIds.some(j => j + 1 === i));
                    break;
                }
            }
        }
        await line.goto(p1);
        const p3 = await line.step(
            this.formatRecallResult(selectedMemories),
            pre.userToAssistant,
        )
        console.log({ grammar: this.taskGrammarMain });
        await line.setSampler([
            { type: "grammar", grammar: this.taskGrammarMain, root: "root" },
            { type: "dist", seed: this.rng.int(0, 32000) },
        ], p3);
        console.log(await line.pull({ eog_stop: true, max_tokens: 1000 }));

        await line.free();
    }
    public formatMemoriesList(memories: MemoContent[], patterns: { main: string, fact: string, rule: string, task: string }) {
        return sprintf(patterns.main, {
            tags: this.tags,
            memories: {
                entries: memories.map((e, i) => sprintf(patterns[e.type], {
                    tags: this.tags,
                    memo: {
                        index: i + 1,
                        briefly: e.briefly,
                        body: e.body,
                        type: e.type,
                        failures: e.failures ?? "N/A",
                    },
                    memories: {
                        count: memories.length,
                    }
                })).join(""),
                count: memories.length,
            }
        });
    }
    public formatRecallResult(memories: MemoContent[]) {
        return memories.length === 0 ? "" : this.formatMemoriesList(memories, {
            main: this.patterns.recallResult,
            fact: this.patterns.recallResultFactEntry,
            rule: this.patterns.recallResultRuleEntry,
            task: this.patterns.recallResultTaskEntry
        });
    }
    public formatRecallSelector(memories: MemoContent[]) {
        return this.formatMemoriesList(memories, {
            main: this.patterns.recallSelector,
            fact: this.patterns.recallSelectorFactEntry,
            rule: this.patterns.recallSelectorRuleEntry,
            task: this.patterns.recallSelectorTaskEntry
        });
    }
    public async formatTask(task: MemoContent & { type: "task" }) {
        const dependencies = (await Promise.all(task.dependencies.map(name => this.memory.getMemo(name)))).filter(e => e?.content?.type === "task") as Memo[];
        return sprintf(this.patterns.task, {
            tags: this.tags,
            task: {
                dependencies: dependencies.length === 0 ? "" : sprintf(this.patterns.taskDependencies, {
                    tags: this.tags,
                    dependencies: {
                        entries: dependencies.map((e, i) => sprintf(this.patterns.taskDependenciesEntry, {
                            tags: this.tags,
                            dependency: {
                                index: i + 1,
                                briefly: e.content.briefly,
                                body: e.content.body,
                            },
                            dependencies: {
                                count: dependencies.length,
                            }
                        })).join(""),
                        count: dependencies.length,
                    }
                }),
                dependency_count: dependencies.length,
                briefly: task.briefly,
                body: task.body,
            }
        })
    }
    public readonly close = createFreeEvent("close", async () => {
        await this.modelClient.close();
    });
}


export const TagNameScheme = z.string().regex(/^[a-zA-Z_0-9]+$/);
export const MainParamsScheme = z.object({
    embeddingModel: z.string().optional(),
    embedderParams: z.object({
        port: z.int().min(0).max(65535),
        host: z.string().optional(),
        timeout: z.number().nonnegative().optional(),
        fallbackStartServer: z.object({
            modelFile: z.string(),
            modelArgs: z.array(z.string()).optional(),
            timeout: z.number().nonnegative(),
            stdout: z.enum(["ignore", "inherit"]),
            stderr: z.enum(["ignore", "inherit"]),
        }).optional(),
    }),
    modelParams: z.object({
        timeout: z.number().nonnegative(),
        fallbackStartServer: z.object({
            modelFile: z.string(),
            modelParams: ModelParamsSchema,
            timeout: z.number().nonnegative(),
            stdout: z.enum(["ignore", "inherit"]),
            stderr: z.enum(["ignore", "inherit"]),
        }).optional(),
    }),
    vectorIndexParams: z.object({
        quantization: z.enum(["f64", "f32", "bf16", "f16", "e5m2", "e4m3", "e3m2", "e2m3", "i8", "u8", "b1"]),
        connectivity: z.number(),
        expansion_add: z.number(),
        expansion_search: z.number(),
        multi: z.boolean(),
    }),
    randomSeed: z.union([z.string(), z.null()]),
    taskSamplerMain: SamplerConstructorScheme,
    tags: z.object({
        think: TagNameScheme,
        select_memories: TagNameScheme,
        step_status: TagNameScheme,
    }),
    numbers: z.object({
        vectorIndexThreads: z.int().positive(),
        memoryIndexSaveInterval: z.int().positive(),
        autoRecallQueryLength: z.number(),
        minimalRecallQueryLength: z.number(),
        recallMinDistance: z.number(),
        recallMaxMemories: z.int().positive(),
        recallSelectorMaxTokens: z.int().positive(),
    }),
});
export type MainParams = z.output<typeof MainParamsScheme>;
export async function main(params?: MainParams) {
    const activeFolder = path.join(path.dirname(import.meta.dirname), "workspace");
    await fs.ensureDir(activeFolder);
    await fs.writeFile(path.join(activeFolder, "main-config.schema.json"), JSON.stringify(MainParamsScheme.toJSONSchema(), undefined, 4), { encoding: "utf-8" });
    if (params === undefined) {
        const name = (await fs.readdir(activeFolder)).map(e => /^main-config\.(json[5c]?|toml|ya?ml|ini)$/.exec(e)?.[0]).filter(e => typeof e === 'string')[0];
        if (name === undefined) {
            throw new Error(`missing 'main-config.json' file': neither got params through arguments, nor got 'main-config'`);
        }
        params = z.parse(MainParamsScheme, readConfig(path.join(activeFolder, name)));
    }
    const llamaServerExecPath = path.join(path.dirname(import.meta.dirname), "binaries", "llama-b9844", "llama-server");
    const embedderParams = Object.assign({}, params.embedderParams) as EmbedderCreateParams;
    if (embedderParams.fallbackStartServer !== undefined) {
        embedderParams.fallbackStartServer = Object.assign(Object.assign({}, embedderParams.fallbackStartServer), { llamaServerExecPath });
    }
    const embedder = await Embedder.create(embedderParams);
    const embeddingModels = await getModels(embedder.port, embedder.host);
    let embeddingModel: string | undefined = params.embeddingModel;
    if (embeddingModels.length > 1) {
        throw new Error(`cannot omit 'embeddingModel' parameter when embedder connection presents multiple models`);
    } else if (embeddingModels.length === 1) {
        if (embeddingModel === undefined) {
            embeddingModel = embeddingModels[0]?.id as string;
        }
    } else if (embeddingModels.length === 0) {
        throw new Error(`embedder connection presents no models`);
    } else {
        embeddingModel = embeddingModels[0]?.id as string;
    }
    const embeddingModelInfo = embeddingModels.find(e => e.id === embeddingModel) as GetModelEntry;
    const modelClientParams = Object.assign(Object.assign({}, params.modelParams), { conn: { unix: path.join(activeFolder, "server-socket.sock") } });
    if (modelClientParams.fallbackStartServer !== undefined) {
        modelClientParams.fallbackStartServer = Object.assign(Object.assign({}, modelClientParams.fallbackStartServer));
    }
    const modelClient = await ModelClient.create(modelClientParams);
    const vectorIndexParams: IndexConfig = Object.assign(
        Object.assign({ dimensions: embeddingModelInfo.meta.n_embd, metric: "ip" as MetricKind }, params.vectorIndexParams),
        { quantization: params.vectorIndexParams.quantization as ScalarKind }
    );
    const vectorIndex = new Index(vectorIndexParams);
    const vectorIndexFile = path.join(activeFolder, "vector-index.usearch");
    const vectorIndexMetaFile = path.join(activeFolder, "vector-index.meta.json");
    if (await fs.exists(vectorIndexMetaFile)) {
        const vectorIndexMeta = z.object({
            metric: z.literal("ip"),
            quantization: z.enum(["f64", "f32", "bf16", "f16", "e5m2", "e4m3", "e3m2", "e2m3", "i8", "u8", "b1"]),
            connectivity: z.int().positive(),
            expansion_add: z.int().positive(),
            expansion_search: z.int().positive(),
            multi: z.boolean(),
        }).parse(await fs.readJson(vectorIndexMetaFile, { encoding: "utf-8" }));
        if (await fs.exists(vectorIndexFile)) {
            if (JSON.stringify(vectorIndexMeta) !== JSON.stringify(vectorIndexParams)) {
                await fs.unlink(vectorIndexMetaFile);
                await fs.unlink(vectorIndexFile);
                await fs.writeJson(vectorIndexMetaFile, vectorIndexParams, { encoding: "utf-8" });
                vectorIndex.save(vectorIndexFile);
            }
        } else {
            vectorIndex.save(vectorIndexFile);
        }
    } else {
        if (await fs.exists(vectorIndexFile)) {
            await fs.unlink(vectorIndexFile);
        }
        await fs.writeJson(vectorIndexMetaFile, vectorIndexParams, { encoding: "utf-8" });
        vectorIndex.save(vectorIndexFile);
    }
    vectorIndex.load(vectorIndexFile);
    const memory = await MemoDB.load(path.join(activeFolder, "memo"));
    const memoryIdsFile = path.join(activeFolder, "memory-ids.json")
    let memoryIds: Record<string, string>;
    if (await fs.exists(memoryIdsFile)) {
        memoryIds = z.record(z.string(), z.string()).parse(await fs.readJson(memoryIdsFile, { encoding: "utf-8" }));
    } else {
        memoryIds = {};
        await fs.writeJSON(memoryIdsFile, {}, { encoding: "utf-8" });
    }
    const vectorNormalizer = new VectorNormalizerLib(path.join(path.dirname(import.meta.dirname), "binaries", "utils", "libvector-normalizer.so"));
    const rp = (name: string) => fs.readFile(path.join(activeFolder, "patterns", name), { encoding: "utf-8" });
    const app = new Agent({
        activeFolder,
        modelClient,
        embedder,
        vectorIndexFile,
        vectorIndex,
        memory,
        memoryIdsFile,
        memoryIds,
        rng: new Yurandom(params.randomSeed ?? `${process.pid}_${Date.now()}`),
        vectorNormalizer,
        taskSamplerMain: params.taskSamplerMain,
        tags: params.tags,
        patterns: {
            systemPrompt: await rp("system-prompt.md"),
            task: await rp("task.md"),
            taskDependencies: await rp("task-dependencies.md"),
            taskDependenciesEntry: await rp("task-dependencies-entry.md"),
            recallSelector: await rp("recall-selector.md"),
            recallSelectorFactEntry: await rp("recall-selector-fact.md"),
            recallSelectorRuleEntry: await rp("recall-selector-rule.md"),
            recallSelectorTaskEntry: await rp("recall-selector-task.md"),
            recallResult: await rp("recall-result.md"),
            recallResultFactEntry: await rp("recall-result-fact.md"),
            recallResultRuleEntry: await rp("recall-result-rule.md"),
            recallResultTaskEntry: await rp("recall-result-task.md"),
            taskGrammarMain: await rp("task-grammar-main.gbnf"),
        },
        numbers: params.numbers,
    });
    app.on("close", () => process.exit(0));
    await app.run();
}





//