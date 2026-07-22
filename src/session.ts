import { ClientLine, ModelClient, type PullResult, type StopCondition } from "u-llm-server";
import { Yurandom } from 'yurandom/index.js';




export type SessionHandler = (this: Session, event: PullResult) => void | Promise<void>;
export type SessionInterval = {
    n_tokens: number,
    oninterval: SessionHandler,
};
export type SessionParams = {
    system_message?: string,
    user_message: string,
    stop_entropy?: number,
    intervals?: SessionInterval[],
    onstart?: SessionHandler,
    onentropy?: SessionHandler,
    oneog?: SessionHandler,
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
    public stopEntropy: number = 6;
    public running: boolean = false;
    public intervals: (SessionInterval & { last_checked: number })[] = [];
    public async start(params: SessionParams) {
        await this.line.clear();
        await this.line.push({
            messages: [
                ...(params.system_message === undefined ? [] : [
                    { role: "system" as "system", content: params.system_message }
                ]),
                { role: "user", content: params.user_message },
                { role: "assistant", content: "\uE001" },
            ]
        });
        this.running = true;
        this.stopEntropy = params.stop_entropy ?? this.stopEntropy;
        this.intervals = (params.intervals ?? []).map(({ n_tokens, oninterval }) => ({ n_tokens, oninterval, last_checked: this.line.unparsedTokens.length }));;
        const stopCondition: StopCondition = { max_entropy: this.stopEntropy, eog_stop: true };
        let started = false;
        try {
            while (this.running) {
                if (!started) {
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
                const result = await this.line.pull(stopCondition);
                if (!started) {
                    if (params.onstart !== undefined) {
                        await params.onstart.call(this, result)
                    }
                    started = true;
                }
                if (result.stopReasons.some(e => e === "max_tokens")) {
                    await Promise.all(this.intervals.map(async e => {
                        if (this.line.tokens.length - e.last_checked >= e.n_tokens) {
                            e.last_checked += e.n_tokens;
                            await e.oninterval.call(this, result);
                        }
                    }));
                }
                if (params.onentropy !== undefined && result.stopReasons.some(e => e === "max_entropy")) {
                    await params.onentropy.call(this, result);
                }
                if (params.oneog !== undefined && result.stopReasons.some(e => e === "eog_stop")) {
                    await params.oneog.call(this, result);
                }
            }
        } finally {
            this.running = false;
        }
    }
    public async ask(stop: StopCondition, ...text: Parameters<ClientLine["push"]>) {
        await this.line.cancel();
        const nTokens = await this.line.push(...text);
        const result = await this.line.pull(stop);
        await this.line.trim(nTokens + result.tokens.length);
        return result;
    }
    public stop() {
        this.running = false;
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