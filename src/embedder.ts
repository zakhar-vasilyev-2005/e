import { spawn, type IOType } from "child_process";
import path from "path";
import type { Stream } from "stream";
import type { Serializable } from "./serializable.js";
import * as z from 'zod';




export interface EmbedderConnectParams {
    host?: string | undefined,
    port: number,
    timeout?: number | undefined,
    modelName?: string,
};
export interface EmbedderStartParams {
    llamaServerExecPath: string,
    modelFile: string,
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
                        const info = (await getModels(port, host)).find(e => e.id === params.modelName || params.modelName === undefined);
                        if (info === undefined) {
                            if (params.modelName === undefined) {
                                throw new Error(`no models found on ${host}:${port}`);
                            } else {
                                throw new Error(`cannot find model ${JSON.stringify(params.modelName)} on ${host}:${port}`);
                            }
                        }
                        resolve(new Embedder(port, host, info));
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
    public constructor(
        public readonly port: number,
        public readonly host: string,
        public readonly modelInfo: ModelInfo
    ) { }
    public async embedding(text: string) {
        return (await this.embeddingBatched([text] as [string]))[0];
    }
    public async embeddingBatched<T extends string[]>(input: T): Promise<{ [i in keyof T]: number[] }> {
        if (input.length === 0) {
            throw new Error(`cannot get embedding with no string inputs`);
        }
        if (input.some(e => e.length === 0)) {
            throw new Error(`cannot get embedding from an empty string`);
        }
        const body = { input, model: this.modelInfo.id };
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
export const ModelInfoSchema = z.object({
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
export type ModelInfo = z.output<typeof ModelInfoSchema>;
export async function getModels(port: number, host: string = "localhost") {
    const raw = await (await getResponse({ port, host }, "/models", undefined, "GET")).json();
    return z.object({ data: z.array(ModelInfoSchema) }).parse(raw).data;
}




