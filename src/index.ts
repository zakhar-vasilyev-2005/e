import EventEmitter from 'events';
import { ModelClient, ModelParamsSchema, type ModelClientParams } from 'u-llm-server';
import { createFreeEvent } from './event-util.js';
import { Yurandom } from 'yurandom/index.js';
import { Session } from './session.js';
import { Embedder, getModels, type EmbedderCreateParams, type EmbedderStartParams, type GetModelEntry } from './embedder.js';
import { Index, MetricKind, ScalarKind, type IndexConfig } from 'usearch';
import path from 'path';
import fs from 'fs-extra';
import { MemoDB, readMemo, type Memo, type MemoContent } from './memory.js';
import { cpus } from 'os'
import z from 'zod';
import { getFileTree } from './get-file-tree.js';
import { el } from 'zod/locales';
import { VectorNormalizerLib, type VectorNormalizer } from './vector-normalizer.js';
import { readConfig } from './config.js';
import type { IOType } from 'child_process';





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
    vectorIndexThreads: number,
    memoryIndexSaveInterval: number,
    memory: MemoDB,
    memoryIdsFile: string,
    memoryIds: Record<string, string>,
    rng: Yurandom,
    vectorNormalizer: VectorNormalizer,
    systemPrompt: string,
    autoRecallQueryLength: number,
    minimalRecallQueryLength: number,
    recallMinDistance: number,
}
export class Agent extends EventEmitter<AgentEvents> implements AgentParams {
    public readonly activeFolder: string;
    public readonly modelClient: ModelClient;
    public readonly embedder: Embedder;
    public readonly vectorIndexFile: string;
    public readonly vectorIndex: Index;
    public readonly vectorIndexThreads: number;
    public readonly memoryIndexSaveInterval: number;
    public memoryIndexSaveLoopRunning: boolean = false;
    public readonly memory: MemoDB;
    public readonly memoryIdsFile: string;
    public readonly memoryIds: Record<string, string>;
    public readonly memoryIdsForName: Record<string, string[]>;
    public readonly rng: Yurandom;
    public readonly vectorNormalizer: VectorNormalizer;
    public readonly systemPrompt: string;
    public readonly autoRecallQueryLength: number;
    public readonly minimalRecallQueryLength: number;
    public readonly recallMinDistance: number;
    public constructor(params: AgentParams) {
        super();
        this.activeFolder = params.activeFolder;
        this.modelClient = params.modelClient;
        this.embedder = params.embedder;
        this.vectorIndexFile = params.vectorIndexFile;
        this.vectorIndex = params.vectorIndex;
        this.vectorIndexThreads = params.vectorIndexThreads;
        this.memoryIndexSaveInterval = params.memoryIndexSaveInterval;
        this.memory = params.memory;
        this.memoryIdsFile = params.memoryIdsFile;
        this.memoryIndexSaveInterval = params.memoryIndexSaveInterval;
        this.memoryIds = params.memoryIds;
        this.memoryIdsForName = {};
        for (const id in this.memoryIds) {
            const name = this.memoryIds[id] as string;
            this.memoryIdsForName[name] = [...(this.memoryIdsForName[id] ?? []), id];
        }
        this.rng = params.rng;
        this.vectorNormalizer = params.vectorNormalizer;
        this.systemPrompt = params.systemPrompt;
        this.autoRecallQueryLength = params.autoRecallQueryLength;
        this.minimalRecallQueryLength = params.minimalRecallQueryLength;
        this.recallMinDistance = params.recallMinDistance;
    }
    public beforeRecall: Promise<void>[] = [];
    public async recall(query: RecallQuery, maxCount: number = 5, minDistance: number = 0): Promise<{ memo: Memo, distance: number }[]> {
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
        const result = this.vectorIndex.search(queryVector, maxCount, this.vectorIndexThreads);
        const toDelete: bigint[] = [];
        const memories: { memo: Memo, distance: number }[] = [];
        for (let i = 0; i < maxCount; i++) {
            const vectorId = result.keys[i];
            const distance = result.distances[i];
            if (vectorId === undefined || distance === undefined) {
                throw new Error(`unexpected situation: expected at least {amount} vectors to output from vector index`);
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
            return await this.recall(query, maxCount);
        }
        return memories.filter(e => e.distance >= minDistance);
    }
    public async memorize(content: MemoContent, name: string) {
        if (this.memory.getMemo(name) !== undefined) {
            await this.forget(name);
        }
        await this.memory.addMemo(content, name);
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
    public async forget(memoName: string) {
        await this.memory.removeMemo(memoName);
        const ids = this.memoryIdsForName[memoName] ?? [];
        delete this.memoryIdsForName[memoName];
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
                this.memorize(loadedMemo.content, loadedMemo.name);
                return;
            }
        }));
        const memoryIndexSaveLoop = async () => {
            await this.updateMemoryIndex();
            if (this.memoryIndexSaveLoopRunning) {
                setTimeout(memoryIndexSaveLoop, this.memoryIndexSaveInterval);
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
        const agent = this;
        const lines = await this.modelClient.exec("line_list", null);
        await Promise.all(lines.map(e => { this.modelClient.exec("line_free", { line_id: e.line_id }) }));
        console.log("CONNECTED");
        const tryRecall = (session: Session, query?: string) => {
            if (query === undefined) {
                query = "";
                for (let i = -1; query.length <= this.autoRecallQueryLength; i--) {
                    query += session.line.tokens.at(i)?.piece ?? "";
                }
            };
            if (query.length < this.minimalRecallQueryLength) { return; }
            const memories = this.recall({ query }, 5, this.recallMinDistance);

        };
        await Session.run(this.modelClient, {
            system_message: this.systemPrompt,
            user_message: `Как звали главного героя в произведении "Криптоэффект", от автора "Серая Зона"?`,
            stop_entropy: 7,
            async onstart({ content, text, next }) {
                if (typeof text !== "string") { throw new Error(`no text output at session start was found`); }
                console.log(await agent.embedder.embedding(text));
                this.stop();
            },
            async oneog() {
                this.stop();
            }
        });
    }
    public readonly close = createFreeEvent("close", async () => {
        await this.modelClient.close();
    });
}


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
    vectorIndexThreads: z.number(),
    memoryIndexSaveInterval: z.number(),
    randomSeed: z.union([z.string(), z.null()]),
    autoRecallQueryLength: z.number(),
    minimalRecallQueryLength: z.number(),
    recallMinDistance: z.number(),
});
export type MainParams = z.output<typeof MainParamsScheme>;
export async function main(params?: MainParams) {
    const activeFolder = path.join(path.dirname(import.meta.dirname), "workspace");
    await fs.ensureDir(activeFolder);
    if (params === undefined) {
        const name = (await fs.readdir(activeFolder)).map(e => /^main-config\.(json[5c]?|toml|ya?ml|ini)$/.exec(e)?.[0]).filter(e => e !== null)[0];
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
    const systemPrompt = await fs.readFile(path.join(activeFolder, "system-prompt.md"), { encoding: "utf-8" });
    const app = new Agent({
        activeFolder,
        modelClient,
        embedder,
        vectorIndexFile,
        vectorIndex,
        vectorIndexThreads: params.vectorIndexThreads,
        memoryIndexSaveInterval: params.memoryIndexSaveInterval,
        memory,
        memoryIdsFile,
        memoryIds,
        rng: new Yurandom(params.randomSeed ?? `${process.pid}_${Date.now()}`),
        vectorNormalizer,
        systemPrompt,
        autoRecallQueryLength: params.autoRecallQueryLength,
        minimalRecallQueryLength: params.minimalRecallQueryLength,
        recallMinDistance: params.recallMinDistance,
    });
    app.on("close", () => process.exit(0));
    await app.run();
}





//