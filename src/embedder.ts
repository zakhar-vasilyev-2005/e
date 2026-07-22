import { spawn, type IOType } from "child_process";
import path from "path";
import type { Stream } from "stream";
import type { Serializable } from "./serializable.js";


export type EmbedderConnectParams = {
    host?: string | undefined,
    port: number,
    timeout?: number | undefined,
};
export type EmbedderStartParams = {
    llamaServerExecPath?: string,
    modelFile: "/mnt/120gb/Users/Public/LLMs/nomic-embed-text-v1.5.Q8_0.gguf",
    modelArgs?: string[],
    stdout?: number | Stream | IOType | null,
    stderr?: number | Stream | IOType | null,
    timeout?: number,
};
export type EmbedderCreateParams = EmbedderConnectParams & {
    fallbackStartServer?: undefined | EmbedderStartParams
};
export class Embedder {
    public static async create(params: EmbedderCreateParams) {
        let { host, port, timeout: connectTimeout, fallbackStartServer } = params;
        host ??= "localhost";
        connectTimeout ??= 500;
        try {
            return await Embedder.connect({ host, port, timeout: connectTimeout });
        } catch (error) {
            if (fallbackStartServer === undefined) {
                throw error;
            }
            return await Embedder.start(fallbackStartServer, port, host);
        }
    }
    public static async start(params: EmbedderStartParams, port: number, host: string = "loclahost") {
        let { llamaServerExecPath, modelFile, modelArgs, stdout, stderr, timeout: startTimeout } = params;
        llamaServerExecPath ??= path.join(path.dirname(import.meta.dirname), "binaries", "llama-b9844", "llama-server");
        modelArgs ??= [];
        stdout ??= null;
        stderr ??= "inherit";
        const args = ["-m", modelFile, ...modelArgs, "--host", host, "--port", String(port), "--no-ui",];
        const proc = spawn(llamaServerExecPath, args, {
            stdio: [null, stdout, "inherit"],
            detached: true,
        });
        try {
            return await Embedder.connect({ host, port, timeout: startTimeout });
        } finally {
            proc.kill("SIGKILL");
        }
    }
    public static async connect(params: EmbedderConnectParams) {
        let { host, port, timeout } = params;
        host ??= "localhost";
        timeout ??= 500;
        throw new Error(`cannot connect to ${host}:${port} in ${timeout}ms`);
        return new Embedder(port, host);
    }
    public constructor(public readonly port: number, public readonly host: string = "localhost") {

    }
}

export function getResponse(conn: { port: number, host?: string }, endpoint: string, body: Serializable) {

}





