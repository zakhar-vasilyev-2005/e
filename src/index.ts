import { ModelClient, ModelParamsSchema, SamplerConstructorScheme } from 'u-llm-server';
import { Yurandom } from 'yurandom/index.js';
import { Embedder, type EmbedderCreateParams } from './embedder.js';
import path from 'path';
import fs from 'fs-extra';
import z from 'zod';
import { getFileTree } from './get-file-tree.js';
import { VectorNormalizerLib } from './vector-normalizer.js';
import { readConfig } from './config.js';
import { DocumentDB, DocumentDBVectorIndexConfigScheme } from './memory.js';
import { Agent, type AgentDocKeyData, type AgentFact, type AgentParams, type AgentRule, type AgentTask } from './agent.js';
import { compile as templateCompile } from 'lite-template';
import { Qemu, QemuCreateParamsScheme } from './qemu.js';






export const NameScheme = z.string().regex(/^[a-zA-Z_0-9]+$/);
export const XMLNameScheme = z.string().regex(/^[:a-zA-Z_0-9-]+$/);
export const GrammarNameScheme = z.string().regex(/^[^\0\n\/]+(\/[^\0\n\/]+)*$/u);
export const FilePathScheme = z.string().regex(/^\/?[^\0\n\/]+(\/[^\0\n\/]+)*$/u);
export const FileEncodingScheme = z.enum(["ascii", "utf8", "utf-8", "utf16le", "utf-16le", "ucs2", "ucs-2", "latin1"]);
export const ToolParamsScheme = z.object({
    tool_names: z.array(NameScheme),
    max_tokens: z.int().positive(),
    sampler: SamplerConstructorScheme,
    grammar: GrammarNameScheme.optional(),
});
export type ToolParams = z.output<typeof ToolParamsScheme>;
export const RecallParamsScheme = z.object({
    minDistance: z.number().nonnegative(),
    minSimilarity: z.number().min(0).max(1),
    rules: z.object({
        minDistance: z.number().nonnegative(),
        minSimilarity: z.number().min(0).max(1),
        maxOutput: z.int().nonnegative(),
    }),
    facts: z.object({
        minDistance: z.number().nonnegative(),
        minSimilarity: z.number().min(0).max(1),
        maxOutput: z.int().nonnegative(),
    }),
    tasks: z.object({
        minDistance: z.number().nonnegative(),
        minSimilarity: z.number().min(0).max(1),
        maxOutput: z.int().nonnegative(),
    }),
    maxOutputTotal: z.int().positive(),
    recallSelectorMaxTokens: z.int().positive(),
});
export const MemoParamsScheme = z.object({
    vectorIndexConfig: DocumentDBVectorIndexConfigScheme,
    vectorIndexThreads: z.int().positive(),
    fileEncoding: FileEncodingScheme,
    keyWeightsDynamic: z.boolean(),
});
export const MainParamsScheme = z.object({
    "$schema": z.literal("./main-config.schema.json"),
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
        conn: z.union([
            z.object({ unix: z.string() }),
            z.object({ host: z.string().optional(), port: z.int().min(1024).max(65535) }),
        ]),
        timeout: z.number().nonnegative(),
        fallbackStartServer: z.object({
            modelFile: z.string(),
            modelParams: ModelParamsSchema,
            timeout: z.number().nonnegative(),
            stdout: z.enum(["ignore", "inherit"]),
            stderr: z.enum(["ignore", "inherit"]),
        }).optional(),
    }),
    randomSeed: z.union([z.string(), z.null()]),
    samplers: z.object({
        taskReasoning: SamplerConstructorScheme,
        recall_selector: SamplerConstructorScheme,
    }),
    strings: z.object({
        tags: z.object({
            tool_call: XMLNameScheme,
            askRelevantMemories: XMLNameScheme,
            ask_raw: XMLNameScheme,
            ask_enum: XMLNameScheme,
        }),
        xmlEscapes: z.record(z.string().regex(/^&[a-zA-Z0-9_#-]+;$/u), z.string()),
    }),
    numbers: z.object({
        stepTokensMax: z.int().positive(),
        minStepTokens: z.int().nonnegative(),
        minStepSymbols: z.int().nonnegative(),
        askMaxIterations: z.object({
            askRaw: z.int().positive(),
            askEnum: z.int().positive(),
            askRelevantMemories: z.int().positive(),
        }),
        askMaxTokens: z.object({
            askRaw: z.int().positive(),
            askEnum: z.int().positive(),
            askRelevantMemories: z.int().positive(),
        }),
        recall: RecallParamsScheme,
        firstRecall: RecallParamsScheme,
        autoRecall: z.object({
            autoRecallQueryLength: z.number(),
            minimalQueryLength: z.number(),
            triggerEntropy: z.number().nonnegative(),
        }),
    }),
    toolParams: z.object({
        bash: ToolParamsScheme.extend({
            defaultTimeout: z.int().nonnegative(),
        }),
        python: ToolParamsScheme.extend({
            defaultTimeout: z.int().nonnegative(),
            command: z.array(z.string()),
            tempScriptEncoding: z.string().regex(/^[a-zA-Z0-9_ -]{1,10}$/u)
        }),
        writefile: ToolParamsScheme.extend({
            defaultEncoding: z.string(),
        }),
        readfile: ToolParamsScheme.extend({
            defaultEncoding: z.string(),
        }),
        task_done: ToolParamsScheme,
        split_task: ToolParamsScheme,
    }),
    memo: z.object({
        rules: MemoParamsScheme,
        facts: MemoParamsScheme,
        tasks: MemoParamsScheme,
    }),
    qemu: z.object({
        createParams: QemuCreateParamsScheme,
        memoFolder: z.union([z.null(), z.object({
            mount_tag: NameScheme,
            security_model: z.enum(["passthrough", "mapped-xattr", "mapped-file", "none"]),
        })]),
        rootPassword: z.string().regex(/^[^\n\0\t\r]*$/),
    }),
});
export type MainParams = z.output<typeof MainParamsScheme>;
export async function main(params?: MainParams) {
    const activeFolderName = "workspace";
    const scriptsFolder = path.dirname(import.meta.dirname);
    const activeFolder = path.join(scriptsFolder, activeFolderName);
    const updateUnixConn = async (connObject: { unix?: string | undefined } & Record<string, unknown>) => {
        if (connObject.unix !== undefined && connObject.unix.startsWith(activeFolderName + path.sep)) {
            connObject.unix = path.join(scriptsFolder, connObject.unix);
            await fs.ensureDir(path.dirname(connObject.unix));
        }
    }
    await fs.ensureDir(activeFolder);
    await fs.writeFile(path.join(activeFolder, "main-config.schema.json"), JSON.stringify(MainParamsScheme.toJSONSchema(), undefined, 4), { encoding: "utf-8" });
    if (params === undefined) {
        const name = (await fs.readdir(activeFolder)).map(e => /^main-config\.(json[5c]?|toml|ya?ml|ini)$/.exec(e)?.[0]).filter(e => typeof e === 'string')[0];
        if (name === undefined) {
            throw new Error(`missing 'main-config.json' file': neither got params through arguments, nor got 'main-config'`);
        }
        params = z.parse(MainParamsScheme, readConfig(path.join(activeFolder, name)));
    } else {
        params = Object.assign({}, params);
    }
    const llamaServerExecPath = path.join(scriptsFolder, "binaries", "llama-b9844", "llama-server");
    const embedderParams = Object.assign({}, params.embedderParams) as EmbedderCreateParams;
    if (embedderParams.fallbackStartServer !== undefined) {
        embedderParams.fallbackStartServer = Object.assign({ llamaServerExecPath }, embedderParams.fallbackStartServer);
    }
    const vectorNormalizer = new VectorNormalizerLib(path.join(scriptsFolder, "binaries", "utils", "libvector-normalizer.so"));
    const modelClientParams = params.modelParams;
    await updateUnixConn(modelClientParams.conn);
    const qemuParams = params.qemu.createParams;
    await updateUnixConn(qemuParams.connect.qmp);
    if (qemuParams.fallbackStart !== undefined) {
        if (params.qemu.memoFolder !== null) {
            const memoFolder = {
                path: path.join(activeFolder, "memo"),
                mount_tag: params.qemu.memoFolder.mount_tag,
                security_model: params.qemu.memoFolder.security_model,
            };
            qemuParams.fallbackStart.folders = [memoFolder, ...(qemuParams.fallbackStart.folders ?? [])]
        }
        await updateUnixConn(qemuParams.fallbackStart.qmp);
    }
    if (qemuParams.fallbackStart !== undefined) {
        console.log(`Allowed start qemu, args: ${JSON.stringify(Qemu.argsOf(qemuParams.fallbackStart))}`);
    }
    const [embedder, modelClient, qemu, patterns] = await Promise.all([
        Embedder.create(embedderParams),
        ModelClient.create(modelClientParams).then(modelClient => {
            modelClient.on("error", err => console.error("Mdel Client", err));
            return modelClient;
        }),
        Qemu.create(qemuParams).then(qemu => {
            qemu.qmp.on("error", err => console.error("QMP", err));
            return qemu;
        }),
        Promise.all(
            (await getFileTree(path.join(activeFolder, "patterns")))
                .filter(file => file.endsWith(".ltmpl"))
                .map(async file => {
                    const relative = file.slice(path.join(activeFolder, "patterns").length);
                    const name = relative.startsWith(path.sep) ? relative.slice(1) : relative;
                    const text = await fs.readFile(file, { encoding: "utf8" });
                    return [name, templateCompile(text)] as [string, (a: unknown) => unknown];
                })
        ).then(e => Object.fromEntries(e)),
    ]);
    const rules = new DocumentDB<AgentRule, AgentDocKeyData, any>({
        embedder,
        vectorNormalizer,
        mainFolder: path.join(activeFolder, "memo/rules"),
        vectorIndexConfig: params.memo.rules.vectorIndexConfig,
        vectorIndexThreads: params.memo.rules.vectorIndexThreads,
        fileExtension: ".md",
        fileEncoding: params.memo.rules.fileEncoding,
        serialize(rule) {
            return Agent.serialize(this, rule);
        },
        deserialize(data) {
            return Agent.deserialize(this, "rule", data as string);
        },
        validator: () => ({ valid: true }),
    });
    const facts = new DocumentDB<AgentFact, AgentDocKeyData, any>({
        embedder,
        vectorNormalizer,
        mainFolder: path.join(activeFolder, "memo/facts"),
        vectorIndexConfig: params.memo.facts.vectorIndexConfig,
        vectorIndexThreads: params.memo.facts.vectorIndexThreads,
        fileExtension: ".md",
        fileEncoding: params.memo.facts.fileEncoding,
        serialize(fact) {
            return Agent.serialize(this, fact);
        },
        deserialize(data) {
            return Agent.deserialize(this, "fact", data as string);
        },
        validator: () => ({ valid: true }),
    });
    const tasks = new DocumentDB<AgentTask, AgentDocKeyData, any>({
        embedder,
        vectorNormalizer,
        mainFolder: path.join(activeFolder, "memo/tasks"),
        vectorIndexConfig: params.memo.tasks.vectorIndexConfig,
        vectorIndexThreads: params.memo.tasks.vectorIndexThreads,
        fileExtension: ".md",
        fileEncoding: params.memo.tasks.fileEncoding,
        serialize(task) {
            return Agent.serialize(this, task);
        },
        deserialize(data) {
            return Agent.deserialize(this, "task", data as string);
        },
        async validator(taskDocument) {
            let visited: Record<string, true> = { [taskDocument.name]: true };
            let unchecked: string[] = [taskDocument.name];
            while (unchecked.length !== 0) {
                const newUnchecked: string[] = [];
                for (const name of unchecked) {
                    const depends = (await this.get(name, true)).data.content.dependencies;
                    for (const d of depends) {
                        if (visited[d]) {
                            return { valid: false, message: `loop found (document ${JSON.stringify(d)} found multiple times in dependencies tree)` };
                        }
                        visited[d] = true;
                        newUnchecked.push(d);
                    }
                }
                unchecked = newUnchecked;
            }
            return { valid: true };
        }
    });
    const pattern = (key: string) => {
        const fn = patterns[key];
        if (fn === undefined) {
            throw new Error(`cannot find pattern ${JSON.stringify(key)}`);
        } else {
            return async (a: unknown) => {
                const result = await fn(a);
                if (typeof result !== "string") {
                    throw new Error(`internal error in lite-template module`);
                }
                return result;
            };
        }
    };
    const app = new Agent({
        activeFolder,
        modelClient,
        embedder,
        rng: new Yurandom(params.randomSeed ?? `${process.pid}_${Date.now()}`),
        vectorNormalizer,
        samplers: params.samplers,
        strings: Object.assign(Object.assign({}, params.strings), {
            patterns: {
                systemPrompt: pattern(`system-prompt.ltmpl`),
                recallResult: pattern(`recall-result.ltmpl`),
                recallSelector: pattern(`recall-selector.ltmpl`),
                task: pattern(`task.ltmpl`),
                vectorQuery: pattern(`vector-query.ltmpl`),
                toolCallResult: pattern(`tool-call-result.ltmpl`),
                warningTooLong: pattern(`warning-too-long-step.ltmpl`),
            } as AgentParams["strings"]["patterns"],
            grammar: Object.fromEntries(await Promise.all(
                (await getFileTree(path.join(activeFolder, "grammar"))).map(
                    file => fs.readFile(file, { encoding: "utf-8" }).then(content => {
                        let name = file.slice(path.join(activeFolder, "grammar").length);
                        if (name.startsWith(path.sep)) {
                            name = name.slice(1);
                        }
                        return [name, content] as [string, string];
                    })
                )
            )),
            qemuRootPassword: params.qemu.rootPassword,
        }),
        facts,
        rules,
        tasks,
        toolParams: params.toolParams,
        numbers: params.numbers,
        qemu,
    });
    app.on("close", () => process.exit(0));
    await app.run();
}

