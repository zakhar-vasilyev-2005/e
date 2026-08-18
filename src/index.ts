import EventEmitter from 'events';
import { ClientLine, ModelClient, ModelLine, ModelParamsSchema, runModel, SamplerConstructorScheme, type ChatRole, type ContentElem, type PullResult, type SamplerConstructor, type SamplerParam } from 'u-llm-server';
import { createFreeEvent } from './event-util.js';
import { Yurandom } from 'yurandom/index.js';
import { Embedder, getModels, type EmbedderCreateParams, type ModelInfo } from './embedder.js';
import { Index, MetricKind, ScalarKind, type IndexConfig } from 'usearch';
import path from 'path';
import fs from 'fs-extra';
import z from 'zod';
import { getFileTree } from './get-file-tree.js';
import { VectorNormalizerLib, type VectorNormalizer } from './vector-normalizer.js';
import { readConfig } from './config.js';
import { sprintf } from 'sprintf-js';
import { DocumentDB, DocumentDBVectorIndexConfigScheme, type BaseDB, type DocumentData, type DocumentDataConstructor } from './memory.js';



export type DialogueItem = {
    role: "user" | "system" | "tool" | "assistant",
    content: string,
};
export type Dialogue = DialogueItem[];


export type AgentFact = {
    type: "fact",
    briefly: string,
    body: string
};
export type AgentRule = {
    type: "rule",
    briefly: string,
    body: string
};
export type AgentTask = {
    type: "task",
    status: "done" | "pending" | "in_progress" | "error",
    dependencies: string[], // names of tasks
    briefly: string,
    body: string,
    tries: number,
}

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
    rng: Yurandom,
    vectorNormalizer: VectorNormalizer,
    strings: MainParams["strings"] & {
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
            dialogue: string,
            dialogueMessageUser: string,
            dialogueMessageSystem: string,
            dialogueMessageAssistant: string,
            dialogueMessageTool: string,
        },
        grammar: Record<string, string>,
        xmlEscapes: Record<string, string>,
    };
    numbers: MainParams["numbers"],
    samplers: MainParams["samplers"],
    toolParams: MainParams["toolParams"],
    rules: BaseDB<AgentRule>,
    facts: BaseDB<AgentFact>,
    tasks: BaseDB<AgentTask>,
}
export type ToolName = keyof MainParams["toolParams"];
export type ToolResult = {
    tool: ToolName,
    text: string,
};
export type AskRawParams = {
    line: ClientLine,
    currentRole: ChatRole,
    message: ContentElem | ContentElem[],
    grammar: string,
    validator?: (text: string) => boolean,
    tagName?: string,
    maxTokens?: number,
    maxIterations?: number,
};
export type AskEnumParams<T extends Record<string | number | symbol, string>> = {
    line: ClientLine,
    currentRole: ChatRole,
    message: ContentElem | ContentElem[],
    values: T,
    tagName?: string,
    maxTokens?: number,
    maxIterations?: number,
};
export type AskRelevantMemoriesParams = {
    line: ClientLine,
    currentRole: ChatRole,
    memories: (AgentRule | AgentFact)[],
    firstCall?: boolean | undefined
};
export type TryRecallParams = {
    line: ClientLine,
    messages: Message[],
    query?: string | undefined,
    firstCall?: boolean,
    suffix?: ContentElem | ContentElem[] | undefined,
    prefix?: ContentElem | ContentElem[] | undefined,
}
export type ToolArg = "syntax" | "lines" | "timeout" | "path";
export type Message = { role: ChatRole, content: string };

export class Agent extends EventEmitter<AgentEvents> {
    public readonly activeFolder: string;
    public readonly modelClient: ModelClient;
    public readonly embedder: Embedder;
    public readonly rng: Yurandom;
    public readonly vectorNormalizer: VectorNormalizer;
    public readonly strings: AgentParams["strings"] & { toolCallTrigger: string };
    public readonly numbers: AgentParams["numbers"] & {
        toolHeaderMaxLength: number,
    };
    public readonly samplers: AgentParams["samplers"] & {
        tool_call_header: SamplerParam,
    };
    public readonly tools: {
        name: ToolName,
        aliases: string[],
        grammar: string,
        grammarId: string,
        requiredArgs: ToolArg[],
        optionalArgs: ToolArg[],
    }[];
    public readonly regexes: {
        toolCall: RegExp,
    };
    public readonly initialParams: AgentParams;
    public readonly rules: BaseDB<AgentRule>;
    public readonly facts: BaseDB<AgentFact>;
    public readonly tasks: BaseDB<AgentTask>;
    public static serializeDocument<T extends AgentRule | AgentFact | AgentTask>(db: BaseDB<T>, data: DocumentData<BaseDB<T>, T>): string {
        throw new Error(`not implemented`);
        return "";
    }
    public static deserializeDocument<T extends AgentRule | AgentFact | AgentTask>(db: BaseDB<T>, type: T["type"], data: string): DocumentDataConstructor<T> {
        throw new Error(`not implemented`);
        const body = "";
        const briefly = "";
        return { content: { body, briefly, type } as T, vectorKeys: [] };
    }
    public constructor(params: AgentParams) {
        super();
        this.initialParams = params;
        this.activeFolder = params.activeFolder;
        this.modelClient = params.modelClient;
        this.embedder = params.embedder;
        this.rng = params.rng;
        this.vectorNormalizer = params.vectorNormalizer;
        this.strings = Object.assign(Object.assign({}, params.strings), { toolCallTrigger: `<${params.strings.tags.tool_call} name=\"` });
        const tags = this.strings.tags;
        const { tools, toolArgs, toolHeaderMaxLength } = (() => {
            const toolArgs: { [k in ToolArg]: string } = {
                syntax: `" syntax=\\"" ( ${Object.keys(this.strings.grammar)} ) "\\""`,
                lines: `" lines=\\"" int ( ".." int | "..." ) "\\""`,
                path: `" path=\\"" [^">\\\\n\\t]+ "\\""`,
                timeout: `" timeout=\\"" int "\\""`,
            };
            const toolArgsLength: { [k in keyof typeof toolArgs]: number } = {
                syntax: ` syntax=""`.length + Math.max(...Object.keys(this.strings.grammar).map(e => e.length)),
                lines: ` lines="123456..123456"`.length,
                path: 2000,
                timeout: ` timeout="123456789"`.length,
            };
            const tools = (() => {
                type Args = { required: string[], optional: string[] };
                const tool_args: { [k in keyof (typeof this.initialParams.toolParams)]: Args } = {
                    bash: {
                        required: [],
                        optional: ["timeout", "lines"],
                    },
                    python: {
                        required: [],
                        optional: ["timeout", "lines"],
                    },
                    readfile: {
                        required: ["path"],
                        optional: ["lines"],
                    },
                    writefile: {
                        required: ["path"],
                        optional: ["syntax", "lines"],
                    },
                    split_task: {
                        required: [],
                        optional: [],
                    },
                    task_done: {
                        required: [],
                        optional: [],
                    },
                };
                return Object.entries(this.initialParams.toolParams).map(([k, v]) => [k, v.tool_names] as [string, typeof v.tool_names]).map(([k, v]) => {
                    const args: Args = (tool_args as Record<string, Args>)[k] ?? { required: [], optional: [] };
                    return {
                        name: k,
                        aliases: v,
                        grammar: `( ` + v.map(e => `"${e}"`).join(" | ") + [
                            ` ) "\""`,
                            ...args.required.map(e => "arg-" + e),
                            ..."( " + args.optional.map(e => "arg-" + e).join(" | ") + " )*",
                        ].join(" "),
                        grammarId: "tool-" + k.replaceAll("_", "-"),
                        requiredArgs: args.required,
                        optionalArgs: args.optional,
                    } as Agent["tools"] extends (infer T)[] ? T : never;
                }).filter(e => e.aliases.length !== 0);
            })();
            const toolHeaderMaxLength = Math.max(...tools.map(e => [...e.requiredArgs, ...e.optionalArgs].map(
                a => toolArgsLength[a]).reduce((a, b) => a + b, 0)
            ).map(e => `<${tags.tool_call} name="">`.length + e));
            return { tools, toolArgs, toolHeaderMaxLength };
        })();
        this.numbers = Object.assign(Object.assign({}, params.numbers), { toolHeaderMaxLength });
        this.tools = tools;
        this.regexes = {
            toolCall: new RegExp((
                `<${tags.tool_call} name =\"(` +
                this.tools.flatMap(
                    tool => tool.aliases.map(e => e.replaceAll(/[\\^$.*+?()[\]{}|]/g, m => "\\" + m))
                ).join("|") +
                `)\"([^>]+)>`
            ), "gu"),
        }
        this.samplers = Object.assign(Object.assign({}, params.samplers), {
            tool_call_header: {
                type: "grammar_lazy_patterns",
                grammar: [
                    `int ::= "0" | [1-9][0-9]*`,
                    `nl ::= [\\n]`,
                    `ws ::= [ \t]+`,
                    `spc ::= [ \t\\n]+`,
                    `root ::= "<${tags.tool_call} name=\"" ( ${this.tools.map(e => e.grammarId).join(" | ")} ) ">"`,
                    ...this.tools.map(e => `${e.grammarId} ::= ${e.grammar}`),
                    ...Object.entries(toolArgs).map(([k, v]) => `arg-${k} ::= ${v}`)
                ].join("\n"),
                root: "root",
                triggers: [this.strings.toolCallTrigger],
            } as SamplerParam,
        });
        this.rules = params.rules;
        this.facts = params.facts;
        this.tasks = params.tasks;
    }
    public async recall(query: string): Promise<{ document: string, entry: AgentFact | AgentRule }[]> {
        const rules = await this.rules.find(query, this.numbers.recall.rules.maxOutput);
        const facts = await this.facts.find(query, this.numbers.recall.facts.maxOutput);
        return [
            ...rules.filter(e => e.distance >= this.numbers.recall.rules.minDistance && e.similarity >= this.numbers.recall.rules.minSimilarity),
            ...facts.filter(e => e.distance >= this.numbers.recall.facts.minDistance && e.similarity >= this.numbers.recall.facts.minSimilarity),
        ].filter(e => e.distance >= this.numbers.recall.minDistance && e.similarity >= this.numbers.recall.minSimilarity).toSorted(
            (a, b) => b.similarity - a.similarity
        ).slice(0, this.numbers.recall.maxOutputTotal).map(
            e => ({ document: e.document.name, entry: e.document.data.content })
        );
    }
    public async run() {
        try {
            await this.main();
        } catch (e) {
            console.error(e);
        } finally {
            await this.close();
        }
    }
    public async main() {
        const lines = await this.modelClient.exec("line_list", null);
        await Promise.all(lines.map(e => { this.modelClient.exec("line_free", { line_id: e.line_id }) }));
        console.log("CONNECTED");
        // TODO: make task dependency resolver, we need to determine which tasks we should execute now
        /*
        await this.executeTask((await this.addMemo({
            body: "Do something.",
            briefly: "Short task.",
            type: "task",
            dependencies: [],
            failures: 0,
        }, "temp/short-task.md")).content as any);
        */
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
    /*    public async executeTask(task: MemoContent & { type: "task" }) {
            // TODO: later add splitting task (when needed) and pushing tasks into queue
        }
        public async executeTaskPlain(task: MemoContent & { type: "task" }) {
            const pre = this.modelClient.prefixes;
            const taskText = await this.formatTask(task);
            let messages: Message[] = [];
            const line = await ClientLine.create(this.modelClient, await this.findLineId());
            this.modelClient.on("tokens", e => {
                if (e.line_id === line.lineId) {
                    process.stdout.write(e.input.map(e => e.piece).join(""));
                }
            });
            await line.clear();
            const systemPrompt = this.formatPattern(this.strings.patterns.systemPrompt);
            messages.push({ role: "system", content: systemPrompt });
            messages.push({ role: "user", content: taskText });
            await this.tryRecall(line, messages, taskText, { prefix: [], suffix: [] });
            await line.step(pre.userToAssistant);
            await line.setSampler([this.samplers.tool_call_header, ...this.samplers.taskReasoning], line.tokens.length);
            let taskStep: PullResult;
            // each task must be completed in one tool call (+ corrections): either  a toolcall.split_task or tool.bash or other
            const makeTaskStep = () => line.pull({ eog_stop: true, max_tokens: this.numbers.stepTokensMax, max_entropy: this.numbers.recallTriggerEntropy });
            while (true) {
                while (true) {
                    taskStep = await makeTaskStep();
                    messages.push({ role: "assistant", content: taskStep.text ?? "" });
                    if (taskStep.stopReasons.some(e => e === "max_entropy")) {
                        await this.tryRecall(line, messages);
                    } else {
                        break;
                    }
                }
                    //
                let toolCall: RegExpExecArray | undefined;
                while (true) {
                    this.regexes.toolCall.lastIndex = 0;
                    toolCall = (taskStep.text ?? "").matchAll(this.regexes.toolCall).toArray().at(-1);
                    if (toolCall === undefined) {
                        await line.cancel();
                        await line.push(this.strings.toolCallTrigger);
                        taskStep = await makeTaskStep();
                        continue;
                    } else {
                        break;
                    }
                }
                
                const toolResult = await this.processToolCall(line, toolCall);
                if (toolResult.tool === "task_done" || toolResult.tool === "split_task") {
                    break;
                }
            }
            // TODO: compress history, make memories, unlink task
            await line.free();
        }
    */
    public async askRaw(params: AskRawParams): Promise<string> {
        const pre = this.modelClient.prefixes;
        const { line, currentRole, message, grammar } = params;
        const tagName = params.tagName ?? this.strings.tags.ask_raw;
        const p1 = line.tokens.length;
        if (currentRole !== "user") {
            await line.push(...{
                assistant: [pre.assistantToUser],
                tool: [pre.toolToAssistant, "...", pre.assistantToUser],
                system: [pre.systemToUser],
            }[currentRole]);
        }
        const p2 = await line.step(
            ...(message instanceof Array ? message : [message]),
            pre.userToAssistant
        );
        for (let iteration = 0; true; iteration++) {
            if (iteration >= (params.maxIterations ?? this.numbers.askMaxIterations.askRaw)) {
                throw new Error(`ask: max iterations reached`);
            }
            await line.setSampler([
                { type: "grammar", grammar, root: "root" },
                ...this.samplers.recall_selector,
            ], p2);
            await line.push(`<${tagName}>`);
            const res = await line.pull({
                eog_stop: true,
                max_tokens: params.maxTokens ?? this.numbers.askMaxTokens.askRaw,
            });
            if (res.stopReasons.some(e => e === "max_tokens")) {
                await line.goto(p2);
                continue;
            } else {
                const m = new RegExp(`^<${tagName}>([\\s\\S]*?)</${tagName}>$`, "u").exec(res.text ?? "");
                const answer = m?.[1];
                if (typeof answer !== "string") {
                    throw new Error(`ask broken: cannot extract answer`);
                }
                if (params.validator === undefined || params.validator(answer)) {
                    await line.goto(p1);
                    return answer;
                } else {
                    await line.goto(p2);
                    continue;
                }
            }
        }
    }
    public async askEnum<T extends Record<string | number | symbol, string>>(params: AskEnumParams<T>): Promise<keyof T> {
        const tagName = params.tagName ?? this.strings.tags.ask_enum;
        const grammar = `root ::= <${tagName}> [ \t]* ( ${Object.values(params.values).map(e => e.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")).join(" | ")} ) [ \t]* </${tagName}>`;
        const value = (await this.askRaw({
            line: params.line,
            currentRole: params.currentRole,
            grammar,
            message: params.message,
            tagName,
            maxTokens: params.maxTokens ?? this.numbers.askMaxTokens.askEnum,
            maxIterations: params.maxIterations ?? this.numbers.askMaxIterations.askEnum
        })).trim();
        for (const key of [...Object.getOwnPropertyNames(params.values), ...Object.getOwnPropertySymbols(params.values)]) {
            const v = params.values[key];
            if (v !== undefined && v.trim() === value) {
                return key;
            }
        }
        throw new Error(`askEnum: internal mistake in code (this situation must not happen)`);
    }
    public async askRelevantMemories(params: AskRelevantMemoriesParams) {
        const grammarIndices = (indices: number[]): string => {
            if (indices.length === 0) {
                throw new Error(`bad argument for grammarIndices: indices length must be >= 1`);
            } else if (indices.length === 1) {
                return `"${indices[0]}"`;
            } else {
                return `( "${indices[0]}" | "${indices[0]}" "," [ ]* ${grammarIndices(indices.slice(1))} )`;
            }
        }
        const tagName = this.strings.tags.askRelevantMemories
        const answer = (await this.askRaw({
            line: params.line,
            currentRole: params.currentRole,
            grammar: `root ::= "<${tagName}>" [ \t]* ( "none" | ${grammarIndices(params.memories.map((e, i) => i + 1))} ) [ \t]* "</${tagName}>"`,
            message: this.formatRecallSelector(params.memories),
            tagName,
            maxTokens: ((params.firstCall ?? false) ? this.numbers.firstRecall : this.numbers.recall).recallSelectorMaxTokens,
            maxIterations: this.numbers.askMaxIterations.askRelevantMemories,
        })).trim().toLowerCase();
        const selectedIds = answer === "none" ? [] : answer.split(",").map(e => parseInt(e.matchAll(/\d/g).toArray().join("")));
        return params.memories.filter((e, i) => selectedIds.some(j => j + 1 === i));
    }
    public async tryRecall(params: TryRecallParams) {
        const startPos = params.line.tokens.length;
        const memories = (await this.recall(this.formatRecallQuery(params.messages))).map(e => e.entry);
        const selectedMemories = memories.length === 0 ? [] : await this.askRelevantMemories({
            line: params.line,
            currentRole: "assistant",
            memories,
            firstCall: params.firstCall
        });
        await params.line.goto(startPos);
        if (selectedMemories.length > 0) {
            const recallResult = this.formatRecallResult(selectedMemories);
            params.messages.push({ role: "user", content: recallResult });
            const pre = params.line.client.prefixes;
            const suffix = params.suffix instanceof Array ? params.suffix : [params.suffix ?? pre.assistantToUser];
            const prefix = params.prefix instanceof Array ? params.prefix : [params.prefix ?? pre.userToAssistant];
            await params.line.step(...prefix, recallResult, ...suffix);
        }
    }
    /*
    public async processToolCall(line: ClientLine, header: RegExpExecArray) {
        const pre = this.modelClient.prefixes;
        const tags = this.strings.tags;
        const alias = header[1];
        if (alias === undefined) {
            throw new Error(`unexpected situation: bad value in samplers.tool_call_header or regexes.toolCall`);
        }
        const tool = this.tools.find(tool => tool.aliases.some(e => e === alias));
        if (tool === undefined) {
            throw new Error(`unexpected situation: toolcall with name (alias) ${JSON.stringify(alias)}`);
        }
        const args = Object.fromEntries((header[2] ?? "").matchAll(/ ([a-zA-Z0-9_]+)="([^"]*)"/y).toArray().map(
            e => [e[1] ?? "", (e[2] ?? "").replaceAll(/&[a-zA-Z0-9_#-]+;/g, m => this.strings.xmlEscapes[m] ?? m)] as [string, string]
        ));
        const grammar = this.strings.grammar[tool.name] ?? (args["syntax"] === undefined ? null : this.strings.grammar[args["syntax"]]) ?? null;
        await line.setSampler([
            ...(grammar === null ? [] : [{ type: "grammar", grammar, root: "root" } as SamplerParam]),
            ...(this.toolParams[tool.name].sampler),
        ], line.tokens.length);
        const marker = new RegExp(`<${tags.tool_call}(?=\s|>)[^>]*>|</${tags.tool_call}>`, "gu");
        let depth = 1;
        const maxTokens = this.toolParams[tool.name].max_tokens as number | undefined;
        let lastMatch: RegExpExecArray | null = null;
        const toolBody = await line.pull({
            ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
            eog_stop: true,
            stop_predicate: ({ tokensRecievedNow, text }) => {
                if (tokensRecievedNow.some(e => e.special)) {
                    marker.lastIndex = 0;
                }
                const lastIndex = marker.lastIndex;
                lastMatch = marker.exec(text ?? "");
                if (lastMatch === null) {
                    marker.lastIndex = lastIndex;
                    return false;
                } else {
                    depth += lastMatch[0].startsWith("</") ? -1 : +1;
                    return depth <= 0;
                }
            }
        });
 
        // TODO: integrity must be higher
        const toolText = (toolBody.text ?? "").slice(0, (lastMatch as RegExpExecArray | null)?.index);
        const toolResult = await this.toolCall(tool.name, args, toolText);
        await line.step(pre.assistantToUser, toolResult.text, pre.userToAssistant);
        return toolResult;
    }
    public async toolCall(tool: ToolName, args: Record<string, string>, text: string): Promise<ToolResult> {
        // TODO: later
        return { tool, text: "" };
    }
    */
    public formatPattern(pattern: string, args: object = {}) {
        return sprintf(pattern, Object.assign({
            tags: this.strings.tags,
            date: new Date(),
            toolParams: this.initialParams.toolParams,
        }, args));
    }
    public formatMemoriesList(memories: (AgentRule | AgentFact)[], patterns: { main: string, fact: string, rule: string, task: string }) {
        return this.formatPattern(patterns.main, {
            memories: {
                entries: memories.map((e, i) => this.formatPattern(patterns[e.type], {
                    memo: {
                        index: i + 1,
                        briefly: e.briefly,
                        body: e.body,
                        type: e.type,
                    },
                    memories: {
                        count: memories.length,
                    }
                })).join(""),
                count: memories.length,
            }
        });
    }
    public formatRecallResult(memories: (AgentRule | AgentFact)[]) {
        return memories.length === 0 ? "" : this.formatMemoriesList(memories, {
            main: this.strings.patterns.recallResult,
            fact: this.strings.patterns.recallResultFactEntry,
            rule: this.strings.patterns.recallResultRuleEntry,
            task: this.strings.patterns.recallResultTaskEntry
        });
    }
    public formatRecallSelector(memories: (AgentRule | AgentFact)[]) {
        return this.formatMemoriesList(memories, {
            main: this.strings.patterns.recallSelector,
            fact: this.strings.patterns.recallSelectorFactEntry,
            rule: this.strings.patterns.recallSelectorRuleEntry,
            task: this.strings.patterns.recallSelectorTaskEntry
        });
    }
    public formatRecallQuery(messages: Message[]) {
        const patterns = {
            dialogue: this.strings.patterns.dialogue,
            user: this.strings.patterns.dialogueMessageUser,
            system: this.strings.patterns.dialogueMessageSystem,
            assistant: this.strings.patterns.dialogueMessageAssistant,
            tool: this.strings.patterns.dialogueMessageTool,
        };
        return this.formatPattern(patterns.dialogue, {
            messages: {
                entries: messages.map((e, i) => this.formatPattern(patterns[e.role], {
                    message: {
                        index: i + 1,
                        role: e.role,
                        content: e.content
                    },
                    messages: {
                        count: messages.length,
                    }
                })).join(""),
                count: messages.length,
            }
        });
    }
    public async formatTask(task: AgentTask) {
        const dependencies = await Promise.all(task.dependencies.map(e => this.tasks.get(e, true)));
        return this.formatPattern(this.strings.patterns.task, {
            task: {
                dependencies: dependencies.length === 0 ? "" : this.formatPattern(this.strings.patterns.taskDependencies, {
                    dependencies: {
                        entries: dependencies.map((e, i) => this.formatPattern(this.strings.patterns.taskDependenciesEntry, {
                            dependency: {
                                index: i + 1,
                                name: e.name,
                                briefly: e.data.content.briefly,
                                body: e.data.content.body,
                                tries: e.data.content.tries,
                                status: e.data.content.status,
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



export const NameScheme = z.string().regex(/^[a-zA-Z_0-9]+$/);
export const ToolParamsScheme = z.object({
    tool_names: z.array(NameScheme),
    max_tokens: z.int().positive(),
    sampler: SamplerConstructorScheme,
    grammar: z.string().regex(/^[^\0\n\/]+(\/[^\0\n\/]+)*$/u).optional(),
});
export const RecallParamsScheme = z.object({
    minDistance: z.number().nonnegative(),
    minSimilarity: z.number().min(0).max(1),
    rules: z.object({
        minDistance: z.number().nonnegative(),
        minSimilarity: z.number().min(0).max(1),
        maxOutput: z.int().positive(),
    }),
    facts: z.object({
        minDistance: z.number().nonnegative(),
        minSimilarity: z.number().min(0).max(1),
        maxOutput: z.int().positive(),
    }),
    maxOutputTotal: z.int().positive(),
    recallSelectorMaxTokens: z.int().positive(),
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
            tool_call: NameScheme,
            askRelevantMemories: NameScheme,
            ask_raw: NameScheme,
            ask_enum: NameScheme,
        }),
        xmlEscapes: z.record(z.string().regex(/^&[a-zA-Z0-9_#-]+;$/u), z.string()),
    }),
    numbers: z.object({
        stepTokensMax: z.int().positive(),
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
        writefile: ToolParamsScheme,
        readfile: ToolParamsScheme,
        bash: ToolParamsScheme,
        python: ToolParamsScheme,
        task_done: ToolParamsScheme,
        split_task: ToolParamsScheme,
    }),
    memo: z.object({
        rules: z.object({
            vectorIndexConfig: DocumentDBVectorIndexConfigScheme,
            vectorIndexThreads: z.int().positive(),
        }),
        facts: z.object({
            vectorIndexConfig: DocumentDBVectorIndexConfigScheme,
            vectorIndexThreads: z.int().positive(),
        }),
        tasks: z.object({
            vectorIndexConfig: DocumentDBVectorIndexConfigScheme,
            vectorIndexThreads: z.int().positive(),
        }),
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
    const vectorNormalizer = new VectorNormalizerLib(path.join(path.dirname(import.meta.dirname), "binaries", "utils", "libvector-normalizer.so"));
    const modelClientParams = Object.assign(Object.assign({}, params.modelParams), { conn: { unix: path.join(activeFolder, "server-socket.sock") } });
    if (modelClientParams.fallbackStartServer !== undefined) {
        modelClientParams.fallbackStartServer = Object.assign(Object.assign({}, modelClientParams.fallbackStartServer));
    }
    const modelClient = await ModelClient.create(modelClientParams);
    const rules = new DocumentDB<AgentRule, "utf8">({
        embedder,
        vectorNormalizer,
        mainFolder: path.join(activeFolder, "memo/rules"),
        vectorIndexConfig: params.memo.rules.vectorIndexConfig,
        vectorIndexThreads: params.memo.rules.vectorIndexThreads,
        fileExtension: ".md",
        fileEncoding: "utf8",
        serialize(rule) {
            return Agent.serializeDocument(this, rule);
        },
        deserialize(rule) {
            return Agent.deserializeDocument(this, "rule", rule);
        },
        validator: () => ({ valid: true }),
    });
    const facts = new DocumentDB<AgentFact, "utf8">({
        embedder,
        vectorNormalizer,
        mainFolder: path.join(activeFolder, "memo/rules"),
        vectorIndexConfig: params.memo.facts.vectorIndexConfig,
        vectorIndexThreads: params.memo.facts.vectorIndexThreads,
        fileExtension: ".md",
        fileEncoding: "utf8",
        serialize(fact) {
            return Agent.serializeDocument(this, fact);
        },
        deserialize(fact) {
            return Agent.deserializeDocument(this, "fact", fact);
        },
        validator: () => ({ valid: true }),
    });
    const tasks = new DocumentDB<AgentTask, "utf8">({
        embedder,
        vectorNormalizer,
        mainFolder: path.join(activeFolder, "memo/tasks"),
        vectorIndexConfig: params.memo.tasks.vectorIndexConfig,
        vectorIndexThreads: params.memo.tasks.vectorIndexThreads,
        fileExtension: ".md",
        fileEncoding: "utf8",
        serialize(task) {
            return Agent.serializeDocument(this, task);
        },
        deserialize(task) {
            return Agent.deserializeDocument(this, "task", task);
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
    const rp = (name: string) => fs.readFile(path.join(activeFolder, "patterns", name), { encoding: "utf-8" });
    const app = new Agent({
        activeFolder,
        modelClient,
        embedder,
        rng: new Yurandom(params.randomSeed ?? `${process.pid}_${Date.now()}`),
        vectorNormalizer,
        samplers: params.samplers,
        strings: Object.assign(Object.assign({}, params.strings), {
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
                dialogue: await rp(`dialogue.md`),
                dialogueMessageUser: await rp(`dialogue-message-user.md`),
                dialogueMessageSystem: await rp(`dialogue-message-system.md`),
                dialogueMessageAssistant: await rp(`dialogue-message-assistant.md`),
                dialogueMessageTool: await rp(`dialogue-message-tool.md`),
            },
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
        }),
        facts,
        rules,
        tasks,
        toolParams: params.toolParams,
        numbers: params.numbers,
    });
    app.on("close", () => process.exit(0));
    await app.run();
}





//