import path from 'path';
import { App } from './index.js';
import { ModelClient } from 'u-llm-server';


const app = new App(await ModelClient.create({
    conn: { unix: path.join(path.dirname(import.meta.dirname), "server-socket.sock") },
    timeout: 500,
    fallbackStartServer: {
        modelFile: "/mnt/120gb/Users/Default/LLMs/Llama-3.2-1B-Instruct-IQ4_XS.gguf",
        modelParams: {
            n_gpu_layers: 999,
            main_gpu: 1,
            check_tensors: false,
            split_mode: "none",
            use_extra_bufts: true,
        },
        stdout: null,
        timeout: 100_000,
    }
}));
app.on("close", () => process.exit(0));
await app.run();



//