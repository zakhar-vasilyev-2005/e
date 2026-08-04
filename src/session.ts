import { ClientLine, ModelClient, packTokens, type PullResult, type SamplerConstructor, type StopCondition, type Token, type TokenSequence } from "u-llm-server";
import { Yurandom } from 'yurandom/index.js';




export type SessionHandler = (this: Session, event: PullResult) => void | Promise<void>;
export interface SessionInterval {
    n_tokens: number,
    oninterval: SessionHandler,
};
export interface SessionPattern {
    pattern: RegExp,
    onpattern: (...args: [...Parameters<SessionHandler>, RegExpExecArray]) => ReturnType<SessionHandler>,
};
export interface SessionDefaultHandlers {
    onstart: SessionHandler,
    onevery: SessionHandler,
    onentropy: SessionHandler,
    oneog: SessionHandler,
};
export const sessionDefaultHandlersNone: SessionDefaultHandlers = {
    onstart: () => { },
    onevery: () => { },
    onentropy: () => { },
    oneog: () => { },
};
export interface SessionParams extends Partial<SessionDefaultHandlers> {
    state?: PullResult[],
    system_message?: string,
    user_message: string,
    sampler?: SamplerConstructor,
    stop_entropy?: number,
    intervals?: SessionInterval[],
    patterns?: SessionPattern[],
};
export class Session {
    public static async run(client: ModelClient, params: SessionParams) {
        await Session.create(client).then(p => p.use(s => s.start(params)));
    }
    public static async create(client: ModelClient) {
        const rng = new Yurandom(`${process.pid}_${Date.now()}`);
        let lineId: string;
        while (true) {
            lineId = `session_${rng.hex(3)}`;
            const lines = (await client.exec("line_list", null)).map(e => e.line_id);
            if (!lines.some(e => e === lineId)) {
                break;
            }
        }
        const line = await ClientLine.create(client, lineId, [{ type: "greedy" }]);
        return new Session(line);
    }
    public constructor(public readonly line: ClientLine) { }
    public sampler: SamplerConstructor = [{ type: "greedy" }];
    public stopEntropy: number = 6;
    public running: boolean = false;
    public started: boolean = false;
    public intervals: (SessionInterval & { last_checked: number })[] = []; // we can edit this manually
    public patterns: SessionPattern[] = [];
    public text: string = "";
    public defaultHandlers: SessionDefaultHandlers = sessionDefaultHandlersNone;
    public async start(params: SessionParams) {
        await this.line.clear();
        await this.line.push({
            messages: [
                ...(params.system_message === undefined ? [] : [
                    { role: "system" as "system", content: params.system_message }
                ]),
                { role: "user", content: params.user_message + "\uE001" },
            ]
        });
        this.sampler = params.sampler ?? [{ type: "greedy" }];
        await this.line.setSampler(this.sampler);
        this.running = true;
        this.stopEntropy = params.stop_entropy ?? this.stopEntropy;
        this.intervals = (params.intervals ?? []).map(({ n_tokens, oninterval }) => ({ n_tokens, oninterval, last_checked: this.line.unparsedTokens.length }));;
        this.patterns = (params.patterns ?? []).map(e => ({
            pattern: new RegExp(e.pattern.source, e.pattern.flags.includes("g") ? e.pattern.flags : e.pattern.flags + "g"),
            onpattern: e.onpattern,
        }));
        const stopCondition: StopCondition = { max_entropy: this.stopEntropy, eog_stop: true };
        this.defaultHandlers = {
            onstart: params.onstart ?? (function () {
                this.push(this.line.client.prefixes.userToAssistant);
            }),
            onentropy: params.onentropy ?? (() => { }),
            onevery: params.onevery ?? (() => { }),
            oneog: params.oneog ?? (() => { }),
        };
        try {
            while (this.running) {
                if (!this.started) {
                    stopCondition.max_tokens = 0;
                } else {
                    if (this.intervals.length !== 0) {
                        stopCondition.max_tokens = Math.min(1000000, ...this.intervals.map(e => {
                            const uncheckedTokens = Math.max(0, this.line.tokens.length - e.last_checked);
                            return e.n_tokens - uncheckedTokens;
                        }));
                    } else {
                        delete stopCondition.max_tokens;
                    }
                }
                await this.pull(stopCondition);
            }
        } finally {
            this.running = false;
        }
    }
    public async pull(stopCondition: StopCondition) {
        const result = await this.line.pull(stopCondition);
        for (const piece of result.content) {
            if (typeof piece === "string") {
                this.text += piece;
            } else {
                this.text = "";
            }
        }
        const d = this.defaultHandlers;
        if (d.onstart !== undefined && !this.started) {
            await d.onstart.call(this, result);
        }
        if (d.onevery !== undefined) {
            await d.onevery.call(this, result);
        }
        if (result.stopReasons.some(e => e === "max_tokens")) {
            await Promise.all(this.intervals.map(async e => {
                if (this.line.tokens.length - e.last_checked >= e.n_tokens) {
                    e.last_checked += e.n_tokens;
                    await e.oninterval.call(this, result);
                }
            }));
        }
        await Promise.all(this.patterns.map(async p => {
            const m = p.pattern.exec(this.text);
            if (m !== null) {
                await p.onpattern.call(this, result, m);
            }
        }));
        if (d.onentropy !== undefined && result.stopReasons.some(e => e === "max_entropy")) {
            await d.onentropy.call(this, result);
        }
        if (d.oneog !== undefined && result.stopReasons.some(e => e === "eog_stop")) {
            await d.oneog.call(this, result);
        }
        this.started = true;
    }
    public async ask(stop: StopCondition, ...text: Parameters<ClientLine["push"]>) {
        await this.line.cancel();
        const nTokens = await this.line.push(...text);
        const result = await this.line.pull(stop);
        await this.line.trim(nTokens + result.tokens.length);
        return result;
    }
    public async push(...content: Parameters<ClientLine["push"]>) {
        await this.line.push(...content);
    }
    public async trimTokens(nTokens: number) {
        if (nTokens <= 0) { return; }
        await this.line.trim(nTokens, true);
        this.text = packTokens(this.line.tokens).text ?? "";
    }
    public async trim(nChars: number) {
        if (nChars <= 0) { return; }
        const tokens: Token[] = [];
        let tokensLength: number = 0;
        for (let i = -1; tokensLength < nChars; i--) {
            const token = this.line.tokens.at(i);
            if (token === undefined) {
                break;
            }
            tokensLength += token.piece.length;
            tokens.push(token);
        }
        let suffix: string;
        if (tokensLength > nChars) {
            suffix = (tokens[0] as Token).piece.slice(0, tokensLength - nChars);
        } else {
            suffix = "";
        }
        await this.trimTokens(tokens.length);
        await this.push(suffix);
        this.updateText();
    }
    public updateText() {
        this.text = packTokens(this.line.tokens).text ?? "";
    }
    public stop() {
        this.running = false;
        this.started = false;
    }
    public async close() {
        await this.line.free();
    }
    public async use(cb: (session: this) => void | Promise<void>) {
        try {
            return await cb(this);
        } finally {
            await this.close();
        }
    }
}



//