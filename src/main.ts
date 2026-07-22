import path from 'path';
import { App } from './index.js';
import { ModelClient } from 'u-llm-server';
import { type IOType } from 'child_process';
import { Embedder } from './embedder.js';


const STDOUT_TYPE: IOType = "inherit";
const embedder = await Embedder.create({
    port: 39512,
    timeout: 500,
    fallbackStartServer: {
        modelFile: "/mnt/120gb/Users/Public/LLMs/nomic-embed-text-v1.5.Q8_0.gguf",
        modelArgs: ["-ctk", "q8_0", "-ctv", "q8_0", "-mg", "0", "-ngl", "999", "-sm", "none"],
        stdout: STDOUT_TYPE,
        timeout: 50_000,
    }
});
const modelClient = await ModelClient.create({
    conn: { unix: path.join(path.dirname(import.meta.dirname), "server-socket.sock") },
    timeout: 500,
    fallbackStartServer: {
        modelFile: "/mnt/120gb/Users/Public/LLMs/Llama-3.2-1B-Instruct-IQ4_XS.gguf",
        modelParams: {
            n_gpu_layers: 999,
            main_gpu: 1,
            check_tensors: false,
            split_mode: "none",
            use_extra_bufts: true,
        },
        stdout: STDOUT_TYPE,
        timeout: 100_000,
    }
});
const app = new App(modelClient, embedder);
app.on("close", () => process.exit(0));
await app.run();



//