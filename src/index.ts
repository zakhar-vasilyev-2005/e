import { fork, type IOType } from 'child_process';
import EventEmitter from 'events';
import path from 'path';
import { ClientLine, ModelClient, type ModelParamsSerialized, type SamplerConstructor } from 'u-llm-server';
import { createFreeEvent } from './event-util.js';
import { Yurandom } from 'yurandom/index.js';
import type Stream from 'stream';


export type AppEvents = {
    "close": [],
};
export class App extends EventEmitter<AppEvents> {
    public readonly rng = new Yurandom(`${process.pid}_${Date.now()}`);
    public constructor(public readonly client: ModelClient) {
        super();
    }
    public async run() {
        let lines: ClientLine[] = [];
        const newLine = async (lineId?: string, sampler: SamplerConstructor = [{ type: "greedy" }]) => {
            const line = await ClientLine.create(this.client, lineId, sampler);
            lines.push(line);
            return line;
        }
        try {
            const line = await newLine("main");
            await line.push(this.client.scheme({
                messages: [
                    { role: "user", content: "hello world!" },
                    { role: "assistant", content: "\uE001" }
                ]
            }));
            const res = await line.pull({ eog_stop: true });
            console.log(res);

        } finally {
            await Promise.all(lines.map(l => l.free()));
            await this.close();
        }
    }
    public readonly close = createFreeEvent("close", async () => {
        await this.client.close();
    });
}




//