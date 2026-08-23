import { ChildProcess, spawn } from 'child_process';
import { Client } from 'ssh2'
import * as os from 'os';
import * as path from 'path';
import { portNumbers } from 'get-port';
import { Socket } from 'net';
import { EventEmitter } from 'events';
import * as z from 'zod';
import type { Serializable } from './serializable.js';
import type { ClientChannel, PseudoTtyOptions } from 'ssh2';
import { stripField, stripUndefined, type OrUndefined, type PromiseOrNot } from './typeutils.js';
import shellescape from 'shell-escape';
import type { Duplex } from 'stream';



export const QemuConnectParamsScheme = z.object({
    qmp: z.union([
        z.object({
            unix: z.string(),
            timeout: z.int().nonnegative().optional(),
            interval: z.int().nonnegative().optional(),
        }),
        z.object({
            host: z.string().optional(),
            port: z.int().min(1024).max(65535),
            timeout: z.int().nonnegative().optional(),
            interval: z.int().nonnegative().optional(),
        }),
    ]),
    ssh: z.object({
        host: z.string().optional(),
        port: z.int().min(1024).max(65535),
        username: z.string(),
        password: z.string(),
        timeout: z.int().nonnegative().optional(),
        interval: z.int().nonnegative().optional(),
    }),
});
export const QemuStartParamsScheme = z.object({
    command: z.string().optional(),
    accel: z.enum(["kvm", "xen", "hvf", "nvmm", "whpx", "tcg"]).optional(),
    cpu: z.string().optional(),
    smp: z.object({
        cpus: z.int().nonnegative().optional(),
        maxcpus: z.int().nonnegative().optional(),
        sockets: z.int().nonnegative().optional(),
        dies: z.int().nonnegative().optional(),
        clusters: z.int().nonnegative().optional(),
        cores: z.int().nonnegative().optional(),
        threads: z.int().nonnegative().optional(),
    }).optional(),
    memory: z.union([
        z.object({ size: z.int().nonnegative() }),
        z.object({ size: z.int().nonnegative(), slots: z.int().nonnegative(), maxmem: z.int().nonnegative() })
    ]).optional(),
    disks: z.array(z.object({
        file: z.string(),
        format: z.enum(["raw", "qcow2", "qcow", "qed", "vmdk", "vdi", "vpc", "vhd", "vhdx", "luks", "bochs", "cloop", "cow", "dmg"]).optional(),
        snapshot: z.boolean().optional(),
        interface: z.enum(["ide", "scsi", "sd", "mtd", "floppy", "pflash", "virtio"]).optional(),
        cache: z.enum(["none", "writeback", "unsafe", "directsync", "writethrough"]).optional(),
        aio: z.enum(["threads", "native", "io_uring"]).optional(),
    })),
    folders: z.array(z.object({
        path: z.string(),
        mount_tag: z.string(),
        security_model: z.enum(["passthrough", "mapped-xattr", "mapped-file", "none"]).optional(),
        readonly: z.boolean().optional(),
    })).optional(),
    hostfwd: z.array(z.object({
        protocol: z.enum(["tcp", "udp"]).optional(),
        hostaddr: z.string().optional(),
        hostport: z.int().min(1024).max(65535),
        guestaddr: z.string().optional(),
        guestport: z.int().min(1024).max(65535),
    })).optional(),
    network: z.boolean().optional(),
    graphics: z.enum(["hide", "disable", "enable"]).optional(),
    qmp: z.union([
        z.object({
            unix: z.string(),
        }),
        z.object({
            host: z.string().optional(),
            port: z.int().min(1024).max(65535),
        }),
    ]),
    ssh: z.object({
        host: z.string().optional(),
        port: z.int().min(1024).max(65535).optional(),
    }),
});
export const QemuCreateParamsScheme = z.object({
    connect: QemuConnectParamsScheme,
    fallbackStart: QemuStartParamsScheme.optional(),
    fallbackReconnect: z.object({
        sshTimeout: z.int().nonnegative().optional(),
        sshInterval: z.int().nonnegative().optional(),
        qmpTimeout: z.int().nonnegative().optional(),
        qmpInterval: z.int().nonnegative().optional(),
    }).optional(),
});
export type QemuConnectParams = z.output<typeof QemuConnectParamsScheme>;
export type QemuStartParams = z.output<typeof QemuStartParamsScheme>;
export type QemuCreateParams = z.output<typeof QemuCreateParamsScheme>;
export type QMPEvents = {
    connected: [QMPGreeting["QMP"]],
    ready: [],
    data: [QMPRecievable],
    error: [Error],
};
export const QMPGreetingScheme = z.object({
    QMP: z.object({
        version: z.unknown(),
        capabilities: z.array(z.unknown()),
    }),
});
export const QMPReturnScheme = z.object({
    return: z.record(z.string(), z.unknown()),
    id: z.string().optional(),
});
export const QMPErrorScheme = z.object({
    error: z.object({
        class: z.string(),
        desc: z.string(),
    }),
    id: z.string().optional(),
});
export const QMPEventScheme = z.object({
    timestamp: z.object({
        seconds: z.int().nonnegative(),
        microseconds: z.int().nonnegative(),
    }),
    event: z.record(z.string(), z.unknown()),
    id: z.string().optional(),
});
export const QMPRecievableScheme = z.union([
    QMPGreetingScheme,
    QMPReturnScheme,
    QMPErrorScheme,
    QMPEventScheme,
]);
export type QMPReturn = z.output<typeof QMPReturnScheme>;
export type QMPError = z.output<typeof QMPErrorScheme>;
export type QMPEvent = z.output<typeof QMPEventScheme>;
export type QMPGreeting = z.output<typeof QMPGreetingScheme>;
export type QMPRecievable = z.output<typeof QMPRecievableScheme>;
export class QMP extends EventEmitter<QMPEvents> {
    public readonly socket: Socket = new Socket();
    public buffer: string = "";
    public requiredFeatures: Serializable[] = [];
    public execCount: number = 0;
    public greeting: QMPGreeting["QMP"] | null = null;
    public connect(conn: ({
        unix: string,
        host?: undefined,
        port?: undefined,
    } | {
        unix?: undefined,
        host?: string | undefined,
        port: number,
    }) & {
        timeout?: number | undefined
    }) {
        this.socket.on("data", data => {
            this.buffer += typeof data === "string" ? data : data.toString("utf8");
            const lines = this.buffer.split("\n");
            this.buffer = lines.pop() as string;
            lines.forEach(ln => {
                let raw: unknown = null;
                try { raw = JSON.parse(ln.trim()); } catch { }
                const obj = QMPRecievableScheme.safeParse(raw);
                if (obj.success) {
                    if ("QMP" in obj.data && typeof obj.data.QMP === "object") {
                        this.greeting = obj.data.QMP;
                        this.emit("connected", obj.data.QMP);
                    }
                    this.emit("data", obj.data);
                } else {
                    this.emit("error", obj.error);
                }
            });
        });
        this.socket.on('error', err => this.emit("error", err));
        this.socket.on("ready", async () => {
            await this.exec("qmp_capabilities", { enable: this.requiredFeatures });
            this.emit("ready");
        });
        if (conn.unix === undefined) {
            this.socket.connect({ port: conn.port, host: conn.host ?? "localhost" });
        } else {
            this.socket.connect(conn.unix);
        }
    }
    public async exec(command: string, args: Serializable = {}) {
        return await new Promise<QMPReturn["return"]>((resolve, reject) => {
            const id = String(++this.execCount);
            const handler = (msg: QMPRecievable) => {
                if ("return" in msg && msg.id === id) {
                    this.off("data", handler);
                    resolve(msg.return);
                } else if ("error" in msg && msg.id === id) {
                    this.off("data", handler);
                    reject(Object.assign(new Error(`${msg.error.class}: ${msg.error.desc}`), msg.error));
                }
            };
            this.on("data", handler);
            this.socket.write(JSON.stringify({ execute: command, arguments: args, id }))
        });
    }
    public async close() {
        await new Promise(resolve => this.socket.end(() => resolve(undefined)));
    }
}
export type RwTemplateCbParams = {
    stdout: string,
    stderr: string,
    outputChunks: { type: "stdout" | "stderr", piece: string }[],
    returnCode: number | null,
    hasTimeout: boolean,
};
export type RwTemplateParams<R> = RwBaseOptions & {
    command: string,
    errorMessage: string,
    cb: (params: RwTemplateCbParams) => PromiseOrNot<R>,
};
export type RwBaseOptions = {
    sudoPassword?: string | undefined,
    timeout?: number | undefined,
}
export class Qemu {
    public static async create(params: QemuCreateParams) {
        try {
            return await this.connect(params.connect);
        } catch (e) {
            if (params.fallbackStart === undefined || (e as any).type !== "TIMEOUT") { throw e; }
            const conn = await this.start(params.fallbackStart);
            const { username, password } = params.connect.ssh;
            const qmp = Object.assign({ timeout: params.fallbackReconnect?.qmpTimeout, interval: params.fallbackReconnect?.qmpInterval }, conn.qmp);
            const ssh = Object.assign({ timeout: params.fallbackReconnect?.sshTimeout, interval: params.fallbackReconnect?.sshInterval, username, password }, conn.ssh);
            return await this.connect({ qmp, ssh });
        }
    }
    public static async start(params: QemuStartParams, callback?: (proc: ChildProcess) => void) {
        let { qmp, ssh } = params;
        if (qmp === undefined) {
            qmp = { unix: path.join(os.tmpdir(), crypto.randomUUID()) };
        }
        let defaultPort: number | undefined = undefined;
        for (const port of portNumbers(40000, 65000)) {
            defaultPort = port;
        }
        if (defaultPort === undefined) {
            throw new Error(`net full`);
        }
        ssh.port ??= defaultPort;
        let [stdout, stderr] = ["", ""];
        const proc = await new Promise<ChildProcess>((resolve, reject) => {
            const proc = spawn(params.command ?? "qemu-system-x86_64", this.argsOf(params), { stdio: "pipe", detached: true });
            proc.stdout.on("data", data => { stdout += data.toString(); });
            proc.stderr.on("data", data => { stderr += data.toString(); });
            proc.on("close", code => {
                console.warn(`qemu process exited with code ${code}`, { stdout, stderr });
            });
            proc.on("spawn", () => resolve(proc));
            proc.on('error', err => reject(err));
        });
        proc.on('error', err => { throw err; });
        callback?.(proc);
        return {
            qmp: "unix" in qmp ? { unix: qmp.unix } : { host: qmp.host ?? "localhost", port: qmp.port },
            ssh: { host: ssh.host ?? "localhost", port: ssh.port ?? defaultPort },
        };
    }
    public static toQemuArg(arg: string | number | boolean | Record<string, string | number | boolean | undefined>): string {
        return typeof arg !== "object" ? (
            String(typeof arg === "boolean" ? (arg ? "on" : "off") : arg).replaceAll(",", ",,")
        ) : (Object.entries(arg)
            .map(([k, v]) => v !== undefined ? `${k}=${this.toQemuArg(v)}` : null)
            .filter(e => e !== null)
            .join(",")
        );
    }
    public static argsOf(params: QemuStartParams) {
        if (params.ssh.port === undefined) {
            throw new Error(`cannot generate list of qemu arguments when ssh.port is undefined`);
        }
        const qmp = params.qmp as ({ unix: string, host?: never, port?: never } | { unix?: never, host?: string, port: number });
        return [
            `-cpu`, params.cpu ?? (params.accel === "kvm" || params.accel === "hvf") ? `host` : `max`,
            ...Object.entries({
                accel: "-accel",
                smp: "-smp",
                memory: "-m",
            } as { [k in keyof QemuStartParams]?: string }).flatMap(([key, alias]) => {
                return [alias, this.toQemuArg((params as any)[key])];
            }),
            ...params.disks.flatMap(e => [`-drive`, this.toQemuArg({
                file: e.file,
                format: e.format,
                if: e.interface,
                snapshot: e.snapshot,
                cache: e.cache,
                aio: e.aio,
            })]),
            ...(params.folders ?? []).flatMap(e => [`-virtfs`, `local,` + this.toQemuArg(e as any)]),
            ...({
                hide: [`-display`, `none`],
                disable: [`-nographic`],
                enable: [],
            }[params.graphics ?? `enable`]),
            `-nic`, (params.network ?? true) ? [
                `user,hostfwd=tcp:127.0.0.1:${params.ssh.port}-:22`,
                ...(params.hostfwd ?? []).map(
                    e => `hostfwd=${e.protocol ?? ""}:${e.hostaddr ?? ""}:${e.hostport}-${e.guestaddr ?? ""}:${e.guestport}`
                )
            ].join(",") : `none`,
            `-qmp`, (qmp.unix === undefined ? `tcp:${qmp.host ?? "127.0.0.1"}:${qmp.port}` : `unix:${qmp.unix.replaceAll(",", ",,")}`) + `,server=on,wait=off`,
        ];
    }
    public static async connect(params: QemuConnectParams) {
        const events = new EventEmitter<{ stop: [] }>();
        const start = Date.now();
        const template = async <T>(params: {
            name: string,
            tryConnect: () => Promise<T>,
            timeout: number | undefined,
            interval: number
        }) => {
            while (true) {
                try {
                    return await params.tryConnect();
                } catch (e) {
                    const err = e as Error & Record<string, unknown>;
                    if (
                        err["code"] === "ENOENT" ||
                        err["code"] === "ECONNRESET" ||
                        err["code"] === "ECONNREFUSED"
                    ) {
                        if (params.timeout !== undefined && Date.now() - start >= params.timeout) {
                            events.emit("stop");
                            throw Object.assign(new Error(`timeout expired on ${params.name}: ${params.timeout}ms`), { type: "TIMEOUT", source: err });
                        } else {
                            await new Promise(resolve => setTimeout(resolve, params.interval));
                            continue;
                        }
                    } else {
                        events.emit("stop");
                        throw err;
                    }
                }
            }
        };
        return await Promise.all([
            template({
                name: "qemu.qmp",
                tryConnect: () => new Promise<QMP>((resolve, reject) => {
                    const qmp = new QMP();
                    const onStop = () => qmp.close();
                    events.on("stop", onStop);
                    qmp.on("ready", () => {
                        events.off("stop", onStop);
                        resolve(qmp);
                    });
                    qmp.on("error", err => {
                        events.off("stop", onStop);
                        reject(err);
                    });
                    qmp.connect(params.qmp);
                }),
                timeout: params.qmp.timeout,
                interval: params.qmp.interval ?? 50,
            }),
            template({
                name: "ssh client (connecting to internal vm)",
                tryConnect: () => new Promise<Client>((resolve, reject) => {
                    const ssh = new Client();
                    const onStop = () => ssh.end();
                    events.on("stop", onStop);
                    ssh.on("ready", () => {
                        events.off("stop", onStop);
                        resolve(ssh);
                    });
                    ssh.on("error", err => {
                        events.off("stop", onStop);
                        reject(err);
                    });
                    ssh.connect({
                        host: params.ssh.host ?? "localhost",
                        port: params.ssh.port,
                        timeout: 500,
                        username: params.ssh.username,
                        password: params.ssh.password,
                    });
                }),
                timeout: params.ssh.timeout,
                interval: params.ssh.interval ?? 50,
            }),
        ]).then(([qmp, ssh]) => new Qemu(qmp, ssh));
    }
    public constructor(public readonly qmp: QMP, public readonly ssh: Client) { }
    public async rwTemplate<R>(params: RwTemplateParams<R>) {
        const markers = {
            ok: crypto.randomUUID(),
            error: crypto.randomUUID(),
            end: crypto.randomUUID(),
        };
        const endPattern = new RegExp(`(${markers.ok}|${markers.error})-(\d+)-${markers.end}`, "");
        return await this.shell<R>({ sudoPassword: params.sudoPassword }, stream => new Promise((resolve, reject) => {
            let outputChunks: { type: "stdout" | "stderr", piece: string }[] = [];
            let [stdout, stderr, hasError, hasTimeout] = ["", "", false, false];
            const trimMarker = (start: number, end: number) => {
                const length = end - start;
                if (length <= 0) { return; }
                stdout = stdout.slice(0, start) + stdout.slice(start + length);
                let [pieceStart, itemIndex] = [0, 0];
                let toDelete: { itemIndex: number, itemStart: number, itemEnd: number }[] = [];
                while (true) {
                    const elem = outputChunks[itemIndex];
                    if (elem === undefined) { break; }
                    if (elem.type === "stderr") { continue; }
                    const piece = elem.piece;
                    const pieceEnd = pieceStart + piece.length;
                    if (pieceEnd >= start && pieceStart <= end) {
                        toDelete.push({
                            itemIndex,
                            itemStart: Math.max(0, start - pieceStart),
                            itemEnd: Math.min(end - pieceStart, piece.length),
                        });
                    }
                    pieceStart = pieceEnd;
                    itemIndex++;
                }
                toDelete.forEach(e => {
                    let piece = outputChunks[e.itemIndex]?.piece;
                    if (piece === undefined) {
                        throw new Error(`unexpected situation: bad outputChunks indexing`);
                    }
                    piece = piece.slice(0, e.itemStart) + piece.slice(e.itemEnd);
                    outputChunks[e.itemIndex] = { type: "stdout", piece };
                });
            }
            const pushText = (type: "stdout" | "stderr", text: string) => {
                if (type === "stdout") {
                    stdout += text;
                } else if (type === "stderr") {
                    stderr += text;
                }
                const last = outputChunks.at(-1);
                if (last?.type === type) {
                    last.piece += text;
                } else {
                    outputChunks.push({ type: "stdout", piece: text });
                }
            }
            (stream as Duplex).on("data", data => {
                pushText("stdout", data.toString());
                hasError ||= stdout.includes(markers.error);
                const m = endPattern.exec(stdout);
                if (m !== null) {
                    trimMarker(m.index, m.index + m[0].length);
                    hasError = m[0].startsWith(markers.error);
                    returnCode = parseInt(m[1] ?? "error");
                    if (returnCode === 124 && params.timeout !== undefined) {
                        hasTimeout = true;
                        returnCode = null;
                    }
                    if (hasError || m[0].startsWith(markers.ok)) {
                        stream.end();
                    }
                }
            });
            stream.stderr.on("data", data => pushText("stderr", data.toString()));
            let returnCode: number | null = null;
            stream.on("exit", code => { returnCode = code; });
            (stream as Duplex).on("close", async () => {
                if (returnCode === null) {
                    throw new Error(`unexpected situation: cannot extract returncode`);
                }
                if (hasError) {
                    const comment = stderr.length !== 0 ? stderr : stdout;
                    const message = comment.length === 0 ? params.errorMessage : `${params.errorMessage}: ${comment}`;
                    reject(Object.assign(new Error(message), { stdout, stderr, returncode: returnCode }));
                } else {
                    let result: R;
                    try {
                        result = await params.cb({ stdout, stderr, outputChunks: outputChunks.filter(e => e.piece.length !== 0), hasTimeout, returnCode });
                    } catch (e) {
                        reject(e);
                        return;
                    }
                    resolve(result);
                }
            });
            const commands = {
                main: params.timeout === undefined ? params.command : `timeout ${params.timeout / 1000}s ${params.command}`,
                then: `echo -n "${markers.ok}-$?-${markers.end}"`,
                else_: `echo -n "${markers.error}-$?-${markers.end}"`,
            }
            stream.write(`( ${commands.main} ) && ${commands.then} || ${commands.else_}`);
        }));
    }
    public async writeFile(file: string, content: Buffer | string, options: RwBaseOptions & { encoding?: BufferEncoding | undefined }) {
        const bytes = typeof content === "string" ? Buffer.from(content, options.encoding ?? "utf8") : content;
        await this.rwTemplate({
            sudoPassword: options.sudoPassword,
            timeout: options.timeout,
            command: `base64 -d <<< ${shellescape([bytes.toString("base64")])} > ${shellescape([file])}`,
            errorMessage: `cannot write file ${JSON.stringify(file)} with ${bytes.byteLength} bytes`,
            cb: ({ hasTimeout }) => {
                if (hasTimeout) {
                    throw Object.assign(new Error(`timeout while writing file ${JSON.stringify(file)}`), { type: "TIMEOUT", timeout: options.timeout, file });
                }
            },
        });
    }
    public async readFile(file: string, options: RwBaseOptions & { encoding?: undefined }): Promise<Buffer>;
    public async readFile(file: string, options: RwBaseOptions & { encoding: BufferEncoding }): Promise<string>;
    public async readFile(file: string, options: RwBaseOptions & { encoding?: BufferEncoding | undefined }): Promise<Buffer | string> {
        return await this.rwTemplate({
            sudoPassword: options.sudoPassword,
            timeout: options.timeout,
            command: `base64 ${shellescape([file])}`,
            errorMessage: `cannot read file ${JSON.stringify(file)}`,
            cb({ stdout, hasTimeout }) {
                if (hasTimeout) {
                    throw Object.assign(new Error(`timeout while reading file ${JSON.stringify(file)}`), { type: "TIMEOUT", timeout: options.timeout, file });
                }
                const content = Buffer.from(stdout, "base64");
                return options.encoding === undefined ? content : content.toString(options.encoding);
            },
        });
    }
    public async shell<R>(options: OrUndefined<PseudoTtyOptions & { sudoPassword: string }>, cb: (stream: ClientChannel) => PromiseOrNot<R>) {
        return await new Promise<R>((resolve, reject) => {
            this.ssh.shell(stripField(stripUndefined(options), "sudoPassword"), async (err, stream) => {
                if (err !== undefined) {
                    reject(err);
                    return;
                }
                if (options.sudoPassword !== undefined) {
                    stream.write(`sudo -v >/dev/null 2>&1\n${options.sudoPassword}\n`);
                }
                resolve(await cb(stream));
            });
        });
    }
    public async writeTempFile(content: Buffer | string, options: RwBaseOptions & OrUndefined<{
        encoding: BufferEncoding,
        tmpNamePrefix: string,
        tmpNameSuffix: string,
    }>) {
        const startTime = Date.now();
        const template = `${options.tmpNamePrefix ?? "tmp"}-XXXXXXXXXX-`;
        const file = await this.rwTemplate({
            sudoPassword: options.sudoPassword,
            timeout: options.timeout,
            command: shellescape(["mktemp", ...(options.tmpNameSuffix === undefined ? [] : ["--suffix", options.tmpNameSuffix]), template]),
            errorMessage: `cannot create temp file`,
            cb({ stdout, hasTimeout }) {
                if (hasTimeout) {
                    throw Object.assign(new Error(`timeout while creating temporary file`), { type: "TIMEOUT", timeout: options.timeout });
                }
                return stdout.trim();
            },
        });
        if (options.timeout !== undefined) {
            options = Object.assign(Object.assign({}, options), { timeout: options.timeout - (Date.now() - startTime) })
        }
        await this.writeFile(file, content, options);
        return file;
    }
}



