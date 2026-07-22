import EventEmitter from 'events';
import { ModelClient, packTokens } from 'u-llm-server';
import { createFreeEvent } from './event-util.js';
import { Yurandom } from 'yurandom/index.js';
import { Session } from './session.js';





export type AppEvents = { close: [] };
export class App extends EventEmitter<AppEvents> {
    public readonly rng = new Yurandom(`${process.pid}_${Date.now()}`);
    public constructor(public readonly client: ModelClient) {
        super();
    }
    public async run() {
        try {
            const lines = await this.client.exec("line_list", null);
            await Promise.all(lines.map(e => { this.client.exec("line_free", { line_id: e.line_id }) }));
            console.log("CONNECTED");
            await Session.run(this.client, {
                system_message: `You are a helpful AI-assistant.`,
                user_message: `Как звали главного героя в произведении "Криптоэффект", от автора "Серая Зона"?`,
                stop_entropy: 7,
                onstart({ content, next }) {
                    console.log({ content, next });
                },
                oneog({ content, next }) {
                    console.log({ content: packTokens(this.line.tokens), next });
                    this.stop();
                }
            });
        } finally {
            await this.close();
        }
    }
    public readonly close = createFreeEvent("close", async () => {
        await this.client.close();
    });
}




//