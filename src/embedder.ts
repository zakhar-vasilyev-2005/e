import { spawn, type IOType } from "child_process";
import path from "path";
import type { Stream } from "stream";
import type { Serializable } from "./serializable.js";
import * as z from 'zod';




export interface EmbedderConnectParams {
    host?: string | undefined,
    port: number,
    timeout?: number | undefined,
};
export interface EmbedderStartParams {
    llamaServerExecPath?: string,
    modelFile: "/mnt/120gb/Users/Public/LLMs/nomic-embed-text-v1.5.Q8_0.gguf",
    modelArgs?: string[],
    stdout?: number | Stream | IOType | null,
    stderr?: number | Stream | IOType | null,
    timeout?: number,
};
export interface EmbedderCreateParams extends EmbedderConnectParams {
    fallbackStartServer?: undefined | EmbedderStartParams,
};
export class Embedder {
    public static async create(params: EmbedderCreateParams) {
        try {
            return await Embedder.connect(params);
        } catch (error) {
            if (params.fallbackStartServer === undefined) {
                throw error;
            }
            return await Embedder.start(params.fallbackStartServer, params.port, params.host);
        }
    }
    public static async start(params: EmbedderStartParams, port: number, host: string = "localhost") {
        let { llamaServerExecPath, modelFile, modelArgs, stdout, stderr, timeout } = params;
        llamaServerExecPath ??= path.join(path.dirname(import.meta.dirname), "binaries", "llama-b9844", "llama-server");
        modelArgs ??= [];
        stdout ??= null;
        stderr ??= "inherit";
        const args = ["-m", modelFile, ...modelArgs, "--host", host, "--port", String(port), "--no-ui", "--embeddings"];
        const proc = spawn(llamaServerExecPath, args, {
            stdio: [null, stdout, "inherit"],
            detached: true,
        });
        try {
            return await Embedder.connect({ host, port, timeout });
        } catch (e) {
            proc.kill("SIGKILL");
            throw e;
        }
    }
    public static async connect(params: EmbedderConnectParams) {
        const port = params.port;
        const host = params.host ?? "localhost";
        const timeout = params.timeout ?? 3000;
        const end = Date.now() + (timeout || Number.POSITIVE_INFINITY);
        while (true) {
            const result = await new Promise<Embedder | Error>(async resolve => {
                try {
                    const delay = Math.max(0, end - Date.now());
                    setTimeout(() => resolve(Error(`cannot connect to ${host}:${port} in ${timeout}ms`)), delay);
                    const response = await getResponse({ host, port }, "/health", undefined, "GET");
                    if (response.body === null) {
                        throw new Error(`bad response from server: missing response body at 'GET ${response.url}'`);
                    }
                    const result = await response.json();
                    if (typeof result === "object" && result !== null && "status" in result && result["status"] === "ok") {
                        resolve(new Embedder(port, host));
                    } else {
                        throw new Error(`bad response from server: 'GET ${response.url}' returned ${JSON.stringify(result)}`);
                    }
                } catch (e) {
                    resolve(e as Error);
                }
            });
            if (result instanceof Error) {
                const okError = (e: any) => {
                    if (e.syscall === "connect") { return true; }
                    if (e.statusText !== undefined && String(e.statusText).trim().toLowerCase() === "service unavailable") { return true; }
                    return false;
                };
                if (okError(result) || (result.cause !== undefined && okError(result.cause))) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    continue;
                } else {
                    throw result;
                }
            } else {
                return result;
            }
        }
    }
    public constructor(public readonly port: number, public readonly host: string = "localhost") { }
    public async embedding(text: string) {
        return (await this.embeddingBatched([text] as [string]))[0];
    }
    public async embeddingBatched<T extends string[]>(input: T): Promise<{ [i in keyof T]: number[] }> {
        const body = { input, model: "any" };
        const raw = await (await getResponse({ port: this.port, host: this.host }, "/embeddings", body, "POST")).json();
        const result = z.array(z.object({ index: z.number(), embedding: z.array(z.array(z.number())) })).parse(raw);
        if (result.length !== input.length) {
            throw new Error(`bad server response: expected ${input.length} embeddings, got ${result.length}`);
        }
        result.sort((a, b) => a.index - b.index);
        return result.flatMap(e => e.embedding) as any;
    }
}

export async function getResponse(conn: { port: number, host?: string }, endpoint: `/${string}`, body?: Serializable, method: "GET" | "POST" = "POST") {
    try {
        const response = await fetch(`http://${conn.host ?? "localhost"}:${conn.port}${endpoint}`, {
            method, headers: { "Content-Type": "application/json" },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
            const { status, statusText, url, type, bodyUsed, headers, redirected } = response;
            throw Object.assign(new Error(`${response.status}: ${response.statusText}`), { status, statusText, url, type, bodyUsed, headers: Object.fromEntries(headers.entries()), redirected });
        }
        return response;
    } catch (e) {
        throw e;
    }
}
export const GetModelEntrySchema = z.object({
    id: z.string(),
    aliases: z.array(z.string()),
    tags: z.array(z.string()),
    created: z.int(),
    meta: z.object({
        n_vocab: z.int().nonnegative(),
        n_ctx: z.int().nonnegative(),
        n_ctx_train: z.int().nonnegative(),
        n_embd: z.int().nonnegative(),
        n_params: z.int().nonnegative(),
        size: z.int().nonnegative(),
    }),
});
export type GetModelEntry = z.output<typeof GetModelEntrySchema>;
export async function getModels(port: number, host: string = "localhost") {
    const raw = await (await getResponse({ port, host }, "/models", undefined, "GET")).json();
    return z.object({ data: z.array(GetModelEntrySchema) }).parse(raw).data;
}




