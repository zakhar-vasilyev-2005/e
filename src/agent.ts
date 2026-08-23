import EventEmitter from 'events';
import { ClientLine, ModelClient, type ChatRole, type ContentElem, type SamplerParam } from 'u-llm-server';
import { createFreeEvent } from './event-util.js';
import { Yurandom } from 'yurandom/index.js';
import { Embedder } from './embedder.js';
import { type VectorNormalizer } from './vector-normalizer.js';
import { type BaseDB, type DocumentData, type DocumentDataConstructor, type StoredDocument, type VectorKeyConstructor } from './memory.js';
import { History, type Message } from './history.js';
import type { MainParams, ToolParams } from './index.js';
import matter from 'gray-matter';
import * as z from 'zod';
import { MarkdownParser, type Heading as MdHeading } from 'md2ast';
import { Qemu } from './qemu.js';
import { Stream } from 'stream';
import shellescape from 'shell-escape';


type PromiseOrNot<T> = T | Promise<T>;


export type MemoType = "rule" | "task" | "fact";
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
    status: AgentTaskStatus,
    dependencies: string[], // names of tasks
    briefly: string,
    body: string,
    tries: number,
};
export type AgentTaskLoaded = Omit<AgentTask, "dependencies"> & {
    dependencies: AgentTaskLoaded[],
};
export type AgentTaskStatus = "done" | "pending" | "in_progress" | "error";

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
            systemPrompt: (ctx: { agentConfig: AgentParams }) => PromiseOrNot<string>,
            task: (ctx: { agentConfig: AgentParams, task: AgentTaskLoaded }) => PromiseOrNot<string>,
            recallSelector: (ctx: { agentConfig: AgentParams, memories: (AgentRule | AgentFact | AgentTaskLoaded)[] }) => PromiseOrNot<string>,
            recallResult: (ctx: { agentConfig: AgentParams, memories: (AgentRule | AgentFact | AgentTaskLoaded)[] }) => PromiseOrNot<string>,
            vectorQuery: (ctx: { agentConfig: AgentParams, messages: Message[] }) => PromiseOrNot<string>,
            toolCallResult: (ctx: { agentConfig: AgentParams, toolResult: ToolResult }) => PromiseOrNot<string>,
            warningTooLong: (ctx: { agentConfig: AgentParams, messages: Message[] }) => PromiseOrNot<string>,
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
    qemu: Qemu,
}
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
    memories: (AgentRule | AgentFact | AgentTask)[],
    firstCall?: boolean | undefined
};
export type TryRecallParams = {
    line: ClientLine,
    messages: Message[],
    currentRole: ChatRole,
    query?: string | undefined,
    firstCall?: boolean,
    suffix?: ContentElem | ContentElem[] | undefined,
    prefix?: ContentElem | ContentElem[] | undefined,
}
export type TryToolCallParams = {
    line: ClientLine,
    history: History,
    currentRole: ChatRole,
    toolCallOpenTag: RegExpExecArray,
};
export type ToolCallParams<Name extends ToolName> = {
    name: Name,
    attrs: ArgsOfTool<Name>,
    text: string,
};
export type ToolResult = ToolResultBash | ToolResultPython | ToolResultWriteFile | ToolResultReadFile | ToolResultSplitTask | ToolResultTaskDone;
export type ToolResultBash = {
    toolName: "bash",
    outputChunks: { type: "stdout" | "stderr", piece: string }[],
    returnCode: null | number,
    exitSignal: string | undefined,
    hasTimeout: boolean,
};
export type ToolResultPython = {
    toolName: "python",
    outputChunks: { type: "stdout" | "stderr", piece: string }[],
    hasTimeout: boolean,
};
export type ToolResultWriteFile = {
    toolName: "writefile",
};
export type ToolResultReadFile = {
    toolName: "readfile",
    fragment: string,
};
export type ToolResultSplitTask = {
    toolName: "split_task",
    error?: string,
    tasksCreated: AgentTaskLoaded[],
};
export type ToolResultTaskDone = {
    toolName: "task_done",
};
export type ToolName = keyof MainParams["toolParams"];
export type ToolArg = ({
    [k in ToolName]: (keyof (typeof toolArgsInfo)[k]["required"]) | (keyof (typeof toolArgsInfo)[k]["optional"])
})[ToolName];
export type ToolArgsDeclaration = {
    required: Partial<Record<ToolArg, RegExp>>,
    optional: Partial<Record<ToolArg, RegExp>>,
};
export const toolArgsInfo = {
    bash: {
        required: {},
        optional: {
            timeout: /^0|[1-9][0-9]*$/u,
            lines: /^(0|[1-9][0-9]*)\.\.(0|[1-9][0-9]*|\.)$/u,
        },
    },
    python: {
        required: {},
        optional: {
            timeout: /^0|[1-9][0-9]*$/u,
            lines: /^(0|[1-9][0-9]*)\.\.(0|[1-9][0-9]*|\.)$/u,
            runAsRoot: /^(true|false)$/u,
        },
    },
    readfile: {
        required: {
            path: /^\/?[^\/\n]+(\/[^\/\n]+)*$/u,
        },
        optional: {
            encoding: /^[a-zA-Z0-9_ -]{1,10}$/u,
            lines: /^(0|[1-9][0-9]*)\.\.(0|[1-9][0-9]*|\.)$/u,
        },
    },
    writefile: {
        required: {
            path: /^\/?[^\/\n]+(\/[^\/\n]+)*$/u,
        },
        optional: {
            encoding: /^[a-zA-Z0-9_ -]{1,10}$/u,
            syntax: /^[^\0\n\/]+(\/[^\0\n\/]+)*$/u,
            lines: /^(0|[1-9][0-9]*)\.\.(0|[1-9][0-9]*|\.)$/u,
        },
    },
    split_task: {
        required: {},
        optional: {},
    },
    task_done: {
        required: {},
        optional: {},
    },
};
((a: { [k in keyof AgentParams["toolParams"]]: ToolArgsDeclaration }) => { })(toolArgsInfo);
export type ArgsOfTool<Name extends ToolName> = {
    [k in keyof (typeof toolArgsInfo)[Name]["required"]]: string
} & {
    [k in keyof (typeof toolArgsInfo)[Name]["optional"]]?: string | undefined
};

export function parseMarkdown(content: string) {
    return (new MarkdownParser().parse(content).children
        .map((e, i, a) => ({ start: e.char_num ?? 0, end: a[i + 1]?.char_num ?? content.length, elem: e }))
        .map(e => Object.assign({ text: content.slice(e.start, e.end) }, e))
    );
}

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
        toolCallTag: RegExp,
        toolCallOpenTag: RegExp,
    };
    public readonly initialParams: AgentParams;
    public readonly rules: BaseDB<AgentRule>;
    public readonly facts: BaseDB<AgentFact>;
    public readonly tasks: BaseDB<AgentTask>;
    public readonly qemu: Qemu;
    public static serialize<T extends AgentRule | AgentFact | AgentTask>(db: BaseDB<T>, data: DocumentData<BaseDB<T>, T>): string {
        const kind = { task: "Task", fact: "Fact", rule: "Rule" }[data.content.type];
        const lines: string[] = ["---", `type: ${data.content.type}`];
        if (data.content.type === "task") {
            lines.push(
                `status: ${data.content.status}`,
                `tries: ${data.content.tries}`,
                data.content.dependencies.length === 0 ? `dependencies: []` : `dependencies:`,
                ...data.content.dependencies.map(e => `- ${e}`),
            );
        }
        lines.push(
            `---`,
            `# Agent's ${kind}`,
            `## Briefly`,
            data.content.briefly.replaceAll(/\s+/g, " ").trim(),
            "",
            ...data.vectorKeys.flatMap((key, i) => [
                `## Key ${i + 1}`,
                ...key.keyText.trim().split("\n").map(e => `> ${e}`),
                "",
            ]),
            `## ${kind} Body`,
            ...data.content.body.trim().split("\n"),
        );
        return lines.join("\n");
    }
    public static deserialize<T extends AgentRule | AgentFact | AgentTask>(db: BaseDB<T>, type: T["type"], data: string): DocumentDataConstructor<T> {
        const { data: header, content } = matter(data);
        const taskStatuses = ["done", "pending", "in_progress", "error"] as ["done", "pending", "in_progress", "error"];
        ((a: AgentTaskStatus[]) => { })(taskStatuses);
        const sections = parseMarkdown(content).filter(e => e.elem.type === "heading" && e.elem.depth === 2).map(({ start, end }, i, a) => ({
            title: /^#+\s*([^\n]*)\s*$/.exec(content.slice(start, end))?.[1] ?? "",
            content: content.slice(end, a[i + 1]?.start ?? content.length),
        }));
        const body = sections.find(e => /^(Task|Fact|Rule) Body[\.:]?$/.exec(e.title) !== null)?.content;
        const briefly = sections.find(e => /^Briefly[\.:]?$/.exec(e.title) !== null)?.content;
        if (body === undefined) {
            throw new Error(`cannot find Body section in serialized ${type} document`);
        }
        if (briefly === undefined) {
            throw new Error(`cannot find Briefly section in serialized ${type} document`);
        }
        const fields = (type === "task" ? z.object({
            type: z.literal("task"),
            status: z.enum(taskStatuses),
            tries: z.int().nonnegative(),
            dependencies: z.array(z.string()),
        }) : z.object({
            type: z.enum(["rule", "fact"]),
        })).parse(header);
        const vectorKeys: VectorKeyConstructor[] = (sections
            .filter(e => e.title.toLowerCase().startsWith("key"))
            .map(e => ({ text: e.content.replaceAll(/^> ?/gm, ""), weight: 1.0 }))
        );
        return { content: Object.assign({ body, briefly }, fields) as T, vectorKeys };
    }
    public constructor(params: AgentParams) {
        super();
        this.initialParams = params;
        this.activeFolder = params.activeFolder;
        this.modelClient = params.modelClient;
        this.embedder = params.embedder;
        this.rng = params.rng;
        this.vectorNormalizer = params.vectorNormalizer;
        this.strings = Object.assign(Object.assign({}, params.strings), { toolCallTrigger: `<${params.strings.tags.tool_call}` });
        const tags = this.strings.tags;
        const { tools, toolArgs, toolHeaderMaxLength } = (() => {
            const toolArgs: { [k in ToolArg]: string } = {
                syntax: `" syntax=\\"" ( ${Object.keys(this.strings.grammar)} ) "\\""`,
                lines: `" lines=\\"" int ( ".." int | "..." ) "\\""`,
                path: `" path=\\"" "/"? [^">\/\\n\\t]+ ( "/" [^">\/\\n\\t]+ )* "\\""`,
                timeout: `" timeout=\\"" int "\\""`,
                runAsRoot: `" runAsRoot=\\"" ( "true" | "false" ) "\\""`,
                encoding: `" encoding=\\"" [a-zA-Z0-9_ -]{1,10} "\\""`,
            };
            const toolArgsLength: { [k in keyof typeof toolArgs]: number } = {
                syntax: ` syntax=""`.length + Math.max(...Object.keys(this.strings.grammar).map(e => e.length)),
                lines: ` lines="123456..123456"`.length,
                path: 2000,
                timeout: ` timeout="123456789"`.length,
                runAsRoot: ` runAsRoot="false"`.length,
                encoding: ` encoding="1234567890"`.length,
            };
            const tools = (() => {
                return Object.entries(this.initialParams.toolParams).map(([k, v]) => [k, v.tool_names] as [string, typeof v.tool_names]).map(([k, v]) => {
                    const args: ToolArgsDeclaration = (toolArgsInfo as Record<string, ToolArgsDeclaration>)[k] ?? { required: {}, optional: {} };
                    return {
                        name: k,
                        aliases: v,
                        grammar: `( ` + v.map(e => `"${e}"`).join(" | ") + [
                            ` ) "\""`,
                            ...Object.keys(args.required).map(e => "arg-" + e),
                            ..."( " + Object.keys(args.optional).map(e => "arg-" + e).join(" | ") + " )*",
                        ].join(" "),
                        grammarId: "tool-" + k.replaceAll("_", "-"),
                        requiredArgs: Object.keys(args.required),
                        optionalArgs: Object.keys(args.optional),
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
            toolCallTag: new RegExp(`<${tags.tool_call}([^>]*)>|</${tags.tool_call}>`, "gu"),
            toolCallOpenTag: new RegExp(`<${tags.tool_call}([^>]*)>`, "gu"),
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
        this.qemu = params.qemu;
    }
    public async recall(query: string): Promise<{ document: string, entry: AgentFact | AgentRule | AgentTask }[]> {
        const rules = await this.rules.find(query, this.numbers.recall.rules.maxOutput);
        const facts = await this.facts.find(query, this.numbers.recall.facts.maxOutput);
        const tasks = await this.tasks.find(query, this.numbers.recall.tasks.maxOutput);
        return [
            ...rules.filter(e => e.distance >= this.numbers.recall.rules.minDistance && e.similarity >= this.numbers.recall.rules.minSimilarity),
            ...facts.filter(e => e.distance >= this.numbers.recall.facts.minDistance && e.similarity >= this.numbers.recall.facts.minSimilarity),
            ...tasks.filter(e => e.distance >= this.numbers.recall.tasks.minDistance && e.similarity >= this.numbers.recall.tasks.minSimilarity),
        ].filter(e => e.distance >= this.numbers.recall.minDistance && e.similarity >= this.numbers.recall.minSimilarity).toSorted(
            (a, b) => b.similarity - a.similarity
        ).slice(0, this.numbers.recall.maxOutputTotal).map(
            e => ({ document: e.document.name, entry: e.document.data.content })
        );
    }
    public async run() {
        try {
            const lines = await this.modelClient.exec("line_list", null);
            await Promise.all(lines.map(e => { this.modelClient.exec("line_free", { line_id: e.line_id }) }));
            console.log("CONNECTED");
            await this.main();
        } catch (e) {
            console.error(e);
        } finally {
            await this.close();
        }
    }
    public async main() {
        if (await this.tasks.get("task1") !== null) {
            await this.tasks.remove("task1");
        }
        // await this.tasks.add("task1", {
        //     body: "Some body.",
        //     briefly: "A briefly.",
        //     dependencies: [],
        //     status: "pending",
        //     tries: 4,
        //     type: "task",
        // }, [{ text: "some key 1", weight: 1.0 }]);
        while (true) {
            const tasks = await Promise.all((await this.tasks.list()).map(name => this.tasks.get(name, true)));
            const pending = tasks.filter(e => e.data.content.status === "pending");
            const available = (await Promise.all(pending.map(async task => {
                const dependencies = await Promise.all(task.data.content.dependencies.map(e => this.tasks.get(e, true)))
                return { task, available: dependencies.every(e => e.data.content.status === "done") };
            }))).filter(e => e.available).map(e => e.task);
            const task = available.at(0);
            if (task === undefined) {
                console.log("NO ENTRY TASK FOUND: work stopped");
                return;
            }
            await this.solve(task);
        }
        // TODO: update task resolver (currently it doesn't handle empty task list and error-ed tasks)
        // TODO: make task solving asynchronous
    }
    public async solve(taskDocument: StoredDocument<BaseDB<AgentTask>, AgentTask>) {
        const agent = this;
        const pre = agent.modelClient.prefixes;
        const line = await ClientLine.create(agent.modelClient, await agent.findLineId());
        let taskSuccess = false;
        try {
            const history = await agent.initHistory(line, taskDocument.data.content); // ends with assistant role
            while (true) {
                await line.setSampler([
                    agent.samplers.tool_call_header,
                    ...agent.samplers.taskReasoning
                ], line.tokens.length);
                const step = await line.pull({
                    eog_stop: true,
                    max_tokens: agent.numbers.stepTokensMax,
                    stop_predicate({ tokensRecieved, text, entropy, stop }) {
                        return stop || (
                            (tokensRecieved.length >= agent.numbers.minStepTokens) &&
                            ((text ?? "").length >= agent.numbers.minStepSymbols) &&
                            (typeof entropy === "number" && entropy >= agent.numbers.autoRecall.triggerEntropy)
                        );
                    }
                });
                await line.setSampler([{ type: "greedy" }], line.tokens.length);
                history.add("assistant", step.text ?? "");
                if (step.stopReasons.some(e => e === "max_entropy")) {
                    const recallResult = await agent.tryRecall({ line, messages: history, currentRole: "assistant" });
                    if (recallResult !== null) {
                        await line.step(pre.assistantToUser, recallResult, pre.userToAssistant);
                        history.add("user", recallResult);
                    }
                }
                if (step.stopReasons.some(e => e === "max_tokens")) {
                    const warningMessage = await agent.formatWarningTooLong(history);
                    await line.step(pre.assistantToUser, warningMessage, pre.userToAssistant);
                    history.add("user", warningMessage);
                }
                const openTag = (step.text ?? "").matchAll(agent.regexes.toolCallOpenTag).toArray().at(-1);
                if (openTag === undefined) {
                    line.push(`<${agent.strings.tags.tool_call}`);
                    continue;
                }
                await agent.tryToolCall({ line, history, currentRole: "assistant", toolCallOpenTag: openTag });
                continue;
                // somehow test to break loop
            }
            // TODO: make loop of steps
            // TODO: make history compression
            // TODO: make task status changing\

        } finally {
            await agent.tasks.update(taskDocument.name, {
                content: Object.assign(taskDocument.data.content, { status: (taskSuccess ? "done" : "error") as AgentTask["status"] })
            })
            await line.free();
        }
    }
    public async initHistory(line: ClientLine, task: AgentTask) {
        const pre = this.modelClient.prefixes;
        const systemPrompt = await this.formatSystemPrompt();
        const taskText = await this.formatTask(task);
        const history = new History();
        history.add("system", systemPrompt);
        history.add("user", taskText);
        await line.step(pre.initToSystem, systemPrompt, pre.systemToUser, taskText);
        const recallResultFirst = await this.tryRecall({
            line,
            messages: history,
            currentRole: "user",
            firstCall: true,
            prefix: [],
        });
        if (recallResultFirst !== null) {
            await line.push(recallResultFirst);
            history.add("user", recallResultFirst);
        }
        await line.step(pre.userToAssistant);
        return history;
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
            message: await this.formatRecallSelector(params.memories),
            tagName,
            maxTokens: ((params.firstCall ?? false) ? this.numbers.firstRecall : this.numbers.recall).recallSelectorMaxTokens,
            maxIterations: this.numbers.askMaxIterations.askRelevantMemories,
        })).trim().toLowerCase();
        const selectedIds = answer === "none" ? [] : answer.split(",").map(e => parseInt(e.matchAll(/\d/g).toArray().join("")));
        return params.memories.filter((e, i) => selectedIds.some(j => j + 1 === i));
    }
    public async tryRecall(params: TryRecallParams) {
        const memories = (await this.recall(params.query ?? await this.formatVectorQuery(params.messages))).map(e => e.entry);
        const selectedMemories = memories.length === 0 ? [] : await this.askRelevantMemories({
            line: params.line,
            currentRole: params.currentRole,
            memories,
            firstCall: params.firstCall
        });
        return selectedMemories.length > 0 ? await this.formatRecallResult(selectedMemories) : null;
    }
    public async tryToolCall(params: TryToolCallParams) {
        const pre = this.modelClient.prefixes;
        const attrsRaw = params.toolCallOpenTag[1] ?? "";
        const attrs: Record<string, string> = {};
        const pattern = /\s+([^>=]+)=("[^"]*"|'[^']*'|[^ >"']*)/uy;
        while (true) {
            const m = pattern.exec(attrsRaw);
            if (m === null) { break; }
            const rawValue = m[2] as string;
            attrs[m[1] as string] = (((/^['"]/.exec(rawValue) === null) ? rawValue : rawValue.slice(1, -1))
                .replaceAll(/&([#0-9a-fA-F]+);/g, m => this.strings.xmlEscapes[m] ?? m)
            );
        }
        const tool = this.tools.find(e => e.aliases.some(ee => ee === attrs["name"]));
        if (tool === undefined) {
            throw new Error(`grammar error: toolcall with no proper tool name found, tool attrs: ${JSON.stringify(attrs)}`);
        }
        const toolInfo = toolArgsInfo[tool.name];
        for (const k in attrs) {
            const p = (toolInfo.required as Record<string, RegExp>)[k] ?? (toolInfo.optional as Record<string, RegExp>)[k];
            if (p === undefined) {
                throw new Error(`grammar error: toolcall with unknown args were allowed, tool attrs: ${JSON.stringify(attrs)}`);
            } else {
                if (p.exec(attrs[k] ?? "") === null) {
                    throw new Error(`grammar error: toolcall with invalid arg values were allowed, context: ${JSON.stringify({ attrName: k, attrValue: attrs[k] ?? "", requiredRegex: p.source })}`);
                }
            }
        }
        for (const k of tool.requiredArgs) {
            if (!(k in attrs)) {
                throw new Error(`grammar error: toolcall with no required args were allowed, tool attrs: ${JSON.stringify(attrs)}`);
            }
        }
        const toolParams = (this.initialParams.toolParams as Record<ToolName, ToolParams>)[tool.name];
        const recommendedSyntax = attrs["syntax" as ToolArg];
        const grammar = (toolParams.grammar !== undefined
            ? this.strings.grammar[toolParams.grammar]
            : (recommendedSyntax === undefined
                ? undefined
                : this.strings.grammar[recommendedSyntax]
            )
        );
        if (grammar === undefined) {
            throw new Error(`cannot find grammar ${JSON.stringify(tool.grammar)}, required for tool ${JSON.stringify(tool.name)}`);
        }
        if (params.currentRole === "user") {
            await params.line.step(pre.userToAssistant);
        } else if (params.currentRole === "tool") {
            await params.line.step(pre.toolToAssistant);
        } else if (params.currentRole === "system") {
            await params.line.step(pre.systemToUser, "...", pre.userToAssistant);
        }
        const sampler = [...toolParams.sampler];
        if (grammar !== undefined) {
            sampler.unshift({ type: "grammar", grammar, root: "root" });
        }
        await params.line.setSampler(sampler, params.line.tokens.length);
        let depth = 1;
        const bodyStep = await params.line.pull({
            eog_stop: true,
            max_tokens: toolParams.max_tokens,
            stop_predicate: ({ tokensRecievedNow, stop, text }) => {
                if (tokensRecievedNow.some(e => e.special)) {
                    this.regexes.toolCallTag.lastIndex = 0;
                }
                const lastIndex = this.regexes.toolCallTag.lastIndex;
                const m = this.regexes.toolCallTag.exec(text ?? "");
                if (m === null) {
                    this.regexes.toolCallTag.lastIndex = lastIndex;
                } else {
                    if (m[0].startsWith("</")) {
                        depth--;
                    } else {
                        depth++;
                    }
                }
                return stop || depth <= 0;
            }
        });
        params.history.add("assistant", bodyStep.text ?? "");
        const eogStop = bodyStep.stopReasons.some(e => e === "eog_stop");
        if (eogStop) {
            await params.line.push(`</${this.strings.tags.tool_call}>`);
        }
        await params.line.push(pre.assistantToUser);
        const text = bodyStep.tokens.filter(e => !e.special).map(e => e.piece).join("");
        delete attrs["name"];
        const result = await this.toolCall({ name: tool.name, attrs, text });
        const textResult = await this.formatToolCallResult(result);
        params.history.add("user", textResult);
        await params.line.step(pre.assistantToUser, textResult, pre.userToAssistant);
    }
    public async toolCall<T extends ToolName>(params: ToolCallParams<T>): Promise<ToolResult & { toolName: T }> {
        const toolName = params.name as ToolName;
        if (toolName === "bash") {
            return await this.executeBash(params as any) as any;
        } else if (toolName === "python") {
            return await this.executePython(params as any) as any;
        } else if (toolName === "writefile") {
            return await this.executeWriteFile(params as any) as any;
        } else if (toolName === "readfile") {
            return await this.executeReadFile(params as any) as any;
        } else if (toolName === "split_task") {
            return await this.executeSplitTask(params as any) as any;
        } else if (toolName === "task_done") {
            return { toolName: "task_done" } as any;
        } else {
            throw new Error(`unexpected situation: cannot find executor for tool ${JSON.stringify(toolName)}`);
        }
    }
    public async executeBash(params: ToolCallParams<"bash">): Promise<ToolResultBash> {
        let timeout = this.initialParams.toolParams.bash.defaultTimeout;
        if (params.attrs.timeout !== undefined && params.attrs.timeout.length !== 0) {
            timeout = parseInt(params.attrs.timeout) * 1000;
        }
        return await this.qemu.shell({
            sudoPassword: this.strings.qemuRootPassword,
        }, stream => new Promise<ToolResultBash>((resolve, reject) => {
            let hasTimeout = false;
            let chunks: ToolResultBash["outputChunks"] = [];
            (stream as Stream).on("data", data => chunks.push({ type: "stdout", piece: data.toString() }));
            stream.stderr.on("data", data => chunks.push({ type: "stderr", piece: data.toString() }));
            stream.on("exit", (returnCode: number | null, exitSignal: string | undefined) => resolve({
                toolName: "bash",
                outputChunks: chunks,
                returnCode,
                exitSignal,
                hasTimeout,
            }));
            setTimeout(() => {
                hasTimeout = true;
                stream.end();
            }, timeout);
            stream.write(params.text.replaceAll("\n", "\r\n"));
        }));
    }
    public async executePython(params: ToolCallParams<"python">): Promise<ToolResultPython> {
        let timeout = this.initialParams.toolParams.python.defaultTimeout;
        if (params.attrs.timeout !== undefined && params.attrs.timeout.length !== 0) {
            timeout = parseInt(params.attrs.timeout) * 1000;
        }
        const asRoot = params.attrs.runAsRoot === "true";
        const sudoPassword = asRoot ? this.strings.qemuRootPassword : undefined;
        const encoding = this.initialParams.toolParams.python.tempScriptEncoding;
        const file = await this.qemu.writeTempFile(params.text, { sudoPassword, encoding: encoding as any });
        return await this.qemu.rwTemplate<ToolResultPython>({
            sudoPassword: this.strings.qemuRootPassword,
            command: shellescape([...this.initialParams.toolParams.python.command, file]),
            errorMessage: `python error`,
            timeout,
            cb({ outputChunks, hasTimeout, returnCode }) {
                return { toolName: "python", outputChunks, hasTimeout, returnCode };
            },
        });
    }
    public async executeWriteFile(params: ToolCallParams<"writefile">): Promise<ToolResultWriteFile> {
        const lines: { start: number, end: number | null } = { start: 0, end: null };
        if (params.attrs.lines !== undefined) {
            const m = toolArgsInfo.writefile.optional.lines.exec(params.attrs.lines);
            if (m === null) {
                throw new Error(`unexpected situation: cannot parse tool arg 'lines'`);
            }
            lines.start = parseInt(m[1] ?? "0");
            lines.end = m[2] === "." ? null : parseInt(m[2] ?? "0");
        }
        const encoding = params.attrs.encoding ?? this.initialParams.toolParams.writefile.defaultEncoding;
        let content = (await this.qemu.readFile(params.attrs.path, { encoding: encoding as BufferEncoding })).split("\n");
        content = [...content.slice(0, lines.start), ...params.text.split("\n"), ...content.slice(lines.end ?? content.length)];
        await this.qemu.writeFile(params.attrs.path, content.join("\n"), { encoding: encoding as any });
        return { toolName: "writefile" };
    }
    public async executeReadFile(params: ToolCallParams<"readfile">): Promise<ToolResultReadFile> {
        const lines: { start: number, end: number | null } = { start: 0, end: null };
        if (params.attrs.lines !== undefined) {
            const m = toolArgsInfo.readfile.optional.lines.exec(params.attrs.lines);
            if (m === null) {
                throw new Error(`unexpected situation: cannot parse tool arg 'lines'`);
            }
            lines.start = parseInt(m[1] ?? "0");
            lines.end = m[2] === "." ? null : parseInt(m[2] ?? "0");
        }
        const encoding = params.attrs.encoding ?? this.initialParams.toolParams.writefile.defaultEncoding;
        let content = await this.qemu.readFile(params.attrs.path, { encoding: encoding as BufferEncoding });
        const fragment = content.split("\n").slice(lines.start, lines.end ?? undefined).join("\n");
        return { toolName: "readfile", fragment };
    }
    public async executeSplitTask(params: ToolCallParams<"split_task">): Promise<ToolResultSplitTask> {
        let tasksCreatedRaw: StoredDocument<BaseDB<AgentTask>, AgentTask>[];
        try {
            tasksCreatedRaw = await this.addMemosBatched(params.text, ["task"]);
        } catch (e) {
            return { toolName: "split_task", tasksCreated: [], error: (e as Error).message };
        }
        const tasksCreated = await Promise.all(tasksCreatedRaw.map(e => this.loadTaskDependencies(e.data.content)));
        return { toolName: "split_task", tasksCreated };
    }
    public async addMemosBatched(text: string, types: []): Promise<never[]>;
    public async addMemosBatched(text: string, types: ["fact"]): Promise<StoredDocument<BaseDB<AgentFact>, AgentFact>[]>;
    public async addMemosBatched(text: string, types: ["task"]): Promise<StoredDocument<BaseDB<AgentTask>, AgentTask>[]>;
    public async addMemosBatched(text: string, types: ["rule"]): Promise<StoredDocument<BaseDB<AgentRule>, AgentRule>[]>;
    public async addMemosBatched(text: string, types: MemoType[]): Promise<(StoredDocument<BaseDB<AgentFact>, AgentFact> | StoredDocument<BaseDB<AgentRule>, AgentRule> | StoredDocument<BaseDB<AgentTask>, AgentTask>)[]>;
    public async addMemosBatched(text: string, types: MemoType[]) {
        const sections = parseMarkdown(text).filter(e => e.elem.type === "heading" && e.elem.depth === 1).map((e, i, a) => ({
            name: (e.elem as MdHeading).children.map(e => "text" in e ? (typeof e.text === "string" ? e.text : "") : "").join(""),
            text: text.slice(e.start, a[i + 1]?.start),
        }));
        let memoType: MemoType | undefined = undefined;
        if (types.length === 1) {
            memoType = types[0] as MemoType;
        }
        const allowedMemoTypes = {
            fact: types.some(e => e === "fact"),
            rule: types.some(e => e === "rule"),
            task: types.some(e => e === "task"),
        };
        return await Promise.all(sections.map(e => {
            const normalizedName = e.name.trim().toLowerCase();
            if (memoType === "task" || (allowedMemoTypes["fact"] && normalizedName.startsWith("task"))) {
                return { name: e.name, doc: Agent.deserialize(this.tasks, "task", e.text) };
            } else if (memoType === "fact" || (allowedMemoTypes["fact"] && normalizedName.startsWith("fact"))) {
                return { name: e.name, doc: Agent.deserialize(this.facts, "fact", e.text) };
            } else if (memoType === "rule" || (allowedMemoTypes["fact"] && normalizedName.startsWith("rule"))) {
                return { name: e.name, doc: Agent.deserialize(this.rules, "rule", e.text) };
            } else {
                throw new Error(`incorrect input: expected the md doc with h1 headings starting with 'fact' | 'rule' | 'task' string`);
            }
        }).map(async e => {
            const name = e.name.trim().matchAll(/[\p{L}\p{N}\p{S}\p{M}~!@#$%\^&*()_+`";:?=\|\\,.<>\[\]{}]+|\/-/gu).toArray().map(e => e[0]).join("_");
            if (e.doc.content.type === "fact") {
                return await this.facts.add(name, e.doc.content, e.doc.vectorKeys);
            } else if (e.doc.content.type === "rule") {
                return await this.rules.add(name, e.doc.content, e.doc.vectorKeys);
            } else if (e.doc.content.type === "task") {
                return await this.tasks.add(name, e.doc.content, e.doc.vectorKeys);
            } else {
                throw new Error(`unexpected situation: expected task|rule`);
            }
        }));
    }
    public async loadTaskDependencies(task: AgentTask): Promise<AgentTaskLoaded> {
        const documents = await Promise.all(task.dependencies.map(e => this.tasks.get(e, true)));
        const dependencies = await Promise.all(documents.map(e => this.loadTaskDependencies(e.data.content)));
        return Object.assign(Object.assign({}, task), { dependencies });
    }
    public async formatSystemPrompt() {
        return await this.strings.patterns.systemPrompt({
            agentConfig: this.initialParams,
        });
    }
    public async formatRecallResult(memories: (AgentRule | AgentFact | AgentTask)[]) {
        return await this.strings.patterns.recallResult({
            memories: await Promise.all(memories.map(e => e.type === "task" ? this.loadTaskDependencies(e) : e)),
            agentConfig: this.initialParams,
        });
    }
    public async formatRecallSelector(memories: (AgentRule | AgentFact | AgentTask)[]) {
        return await this.strings.patterns.recallSelector({
            memories: await Promise.all(memories.map(e => e.type === "task" ? this.loadTaskDependencies(e) : e)),
            agentConfig: this.initialParams,
        });
    }
    public async formatVectorQuery(messages: Message[]) {
        return await this.strings.patterns.vectorQuery({
            messages,
            agentConfig: this.initialParams,
        });
    }
    public async formatToolCallResult(toolResult: ToolResult) {
        return await this.strings.patterns.toolCallResult({
            toolResult,
            agentConfig: this.initialParams,
        });
    }
    public async formatWarningTooLong(messages: Message[]) {
        return await this.strings.patterns.warningTooLong({
            messages,
            agentConfig: this.initialParams,
        });
    }
    public async formatTask(task: AgentTask) {
        return await this.strings.patterns.task({
            task: await this.loadTaskDependencies(task),
            agentConfig: this.initialParams,
        })
    }
    public readonly close = createFreeEvent("close", async () => {
        await this.modelClient.close();
    });
}





//