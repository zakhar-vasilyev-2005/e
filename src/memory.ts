import path from "path";
import fs from 'fs-extra';
import type { Serializable } from "./serializable.js";
import { Index, MetricKind, ScalarKind, type IndexConfig } from 'usearch';
import * as sqlite3 from 'better-sqlite3';
import * as z from 'zod';
import { type Embedder } from "./embedder.js";
import type { VectorNormalizer } from "./vector-normalizer.js";



type PromiseOrNot<T> = Promise<T> | T;

export interface BaseDB<Payload extends Serializable> {
    folder: string,
    get(name: string, ensureExists?: false): PromiseOrNot<StoredDocument<this, Payload> | null>,
    get(name: string, ensureExists: true): PromiseOrNot<StoredDocument<this, Payload>>,
    get(name: string, ensureExists?: boolean): PromiseOrNot<StoredDocument<this, Payload> | null>,
    add(name: string, content: Payload, keys: VectorKeyConstructor[]): PromiseOrNot<StoredDocument<this, Payload>>,
    remove(name: string): PromiseOrNot<StoredDocument<this, Payload>>,
    update(name: string, content: Payload): PromiseOrNot<StoredDocument<this, Payload>>,
    addKey(name: string, ...keys: VectorKeyConstructor[]): PromiseOrNot<StoredDocument<this, Payload>>,
    removeKey(...keys: VectorKey<this, Payload>[]): PromiseOrNot<StoredDocument<this, Payload>>,
    find(query: string, maxResults: number): PromiseOrNot<FoundStoredDocument<this, Payload>[]>,
};
export type VectorKeyConstructor = {
    weight: number,
    text: string,
};
export type VectorKey<DocumentDB extends BaseDB<Payload>, Payload extends Serializable> = {
    db: DocumentDB,
    keyText: string,
    weight: number,
    vectorId: string,
};
export interface VectorKeySelector {
    vectorId: string,
};
export type DocumentDataConstructor<Payload extends Serializable> = {
    vectorKeys: VectorKeyConstructor[],
    content: Payload,
};
export type DocumentData<DocumentDB extends BaseDB<Payload>, Payload extends Serializable> = {
    db: DocumentDB,
    vectorKeys: VectorKey<DocumentDB, Payload>[],
    content: Payload,
};
export type StoredDocument<DocumentDB extends BaseDB<Payload>, Payload extends Serializable> = {
    db: DocumentDB,
    name: string,
    data: DocumentData<DocumentDB, Payload>,
};
export type FoundStoredDocument<DocumentDB extends BaseDB<Payload>, Payload extends Serializable> = {
    document: StoredDocument<DocumentDB, Payload>,
    vectorId: string,
    similarity: number,
    distance: number,
};


export const DocumentDBVectorIndexConfigScheme = z.object({
    quantization: z.enum([
        ScalarKind.B1,
        ScalarKind.BF16,
        ScalarKind.E2M3,
        ScalarKind.E3M2,
        ScalarKind.E4M3,
        ScalarKind.E5M2,
        ScalarKind.F16,
        ScalarKind.F32,
        ScalarKind.F64,
        ScalarKind.I8,
        ScalarKind.U8
    ]),
    connectivity: z.int().positive(),
    expansion_add: z.int().positive(),
    expansion_search: z.int().positive(),
    multi: z.boolean(),
});
export type DocumentDBVectorKeyEntry = {
    vectorId: string,
    keyText: string,
    keyWeight: number,
    documentName: string
};
export type DocumentDBParams<Payload extends Serializable, Encoding extends BufferEncoding | null> = {
    embedder: Embedder,
    vectorNormalizer: VectorNormalizer,
    mainFolder: string,
    vectorIndexConfig: Omit<Omit<IndexConfig, "metric">, "dimensions">,
    vectorIndexThreads: number,
    fileExtension: string,
    fileEncoding: Encoding,
    serialize: (this: DocumentDB<Payload, Encoding>, data: DocumentData<DocumentDB<Payload, Encoding>, Payload>) => Encoding extends "binary" ? Uint8Array : string,
    deserialize: (this: DocumentDB<Payload, Encoding>, data: Encoding extends "binary" ? Buffer : string) => DocumentDataConstructor<Payload>,
};
export const DocumentDBDefaultGlobals = {
    lastVectorId: "1",
};
export type DocumentDBGlobalsEntry = {
    entryName: string,
    entryValue: string,
};
export class DocumentDB<Payload extends Serializable, Encoding extends BufferEncoding | null> implements BaseDB<Payload> {
    public readonly vectorIndex: Index;
    public readonly vectorIndexFile: string;
    public readonly vectorIndexConfigFile: string;
    public readonly vectorIndexThreads: number;
    public readonly fileIndexDatabase: sqlite3.Database;
    public readonly fileIndexDatabaseFile: string;
    public readonly fileIndexQueries: {
        findKeys: sqlite3.Statement<[string], DocumentDBVectorKeyEntry>,
        getKey: sqlite3.Statement<[string], DocumentDBVectorKeyEntry>,
        addKey: sqlite3.Statement<[string, string, number, string]>,
        removeKey: sqlite3.Statement<[string]>,
        getGlobal: sqlite3.Statement<[string], DocumentDBGlobalsEntry>,
        setGlobal: sqlite3.Statement<[string, string]>,
    };
    public readonly folder: string;
    public readonly vectorIndexConfig: Omit<IndexConfig, "metric">;
    public readonly fileExtension: string;
    public readonly fileEncoding: Encoding;
    public readonly embedder: Embedder;
    public readonly vectorNormalizer: VectorNormalizer;
    public readonly serializeDocument: DocumentDBParams<Payload, Encoding>["serialize"];
    public readonly deserializeDocument: DocumentDBParams<Payload, Encoding>["deserialize"];
    public constructor(params: DocumentDBParams<Payload, Encoding>) {
        this.folder = params.mainFolder;
        this.vectorIndexThreads = params.vectorIndexThreads;
        this.vectorIndexConfig = Object.freeze(Object.assign({ dimensions: params.embedder.modelInfo.meta.n_embd }, params.vectorIndexConfig));
        this.serializeDocument = params.serialize;
        this.deserializeDocument = params.deserialize;
        this.fileEncoding = params.fileEncoding;
        this.fileExtension = params.fileExtension;
        this.embedder = params.embedder;
        this.vectorNormalizer = params.vectorNormalizer;
        fs.ensureDirSync(this.folder);
        this.vectorIndexFile = path.join(this.folder, "vector-index.usearch");
        this.vectorIndexConfigFile = path.join(this.folder, "vector-index-config.json");
        if (fs.existsSync(this.vectorIndexFile) && !fs.existsSync(this.vectorIndexConfigFile)) {
            fs.unlinkSync(this.vectorIndexFile);
        }
        if (fs.existsSync(this.vectorIndexConfigFile) && !fs.existsSync(this.vectorIndexFile)) {
            fs.unlinkSync(this.vectorIndexConfigFile);
        }
        if (fs.existsSync(this.vectorIndexFile)) {
            const prevConfig = fs.readJsonSync(this.vectorIndexConfigFile, { encoding: "utf8" });
            for (const k in this.vectorIndexConfig) {
                if (prevConfig[k] !== (this.vectorIndexConfig as Record<string, string | boolean | number>)[k]) {
                    fs.unlinkSync(this.vectorIndexFile);
                    fs.unlinkSync(this.vectorIndexConfigFile);
                    break;
                }
            }
        }
        this.vectorIndex = new Index(Object.assign({ metric: MetricKind.IP }, this.vectorIndexConfig));
        if (fs.existsSync(this.vectorIndexFile)) {
            this.vectorIndex.load(this.vectorIndexFile);
        } else {
            this.vectorIndex.save(this.vectorIndexFile);
            fs.writeJsonSync(this.vectorIndexConfigFile, this.vectorIndexConfig);
        }
        this.fileIndexDatabaseFile = path.join(this.folder, "file-index.sqlite3");
        this.fileIndexDatabase = new sqlite3.default(this.fileIndexDatabaseFile, { fileMustExist: false });
        this.fileIndexDatabase.exec(`
            CREATE TABLE IF NOT EXISTS vectorKeys (
                vectorId TEXT PRIMARY KEY,
                keyText TEXT NOT NULL,
                keyWeight REAL NOT NULL,
                documentName TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS globalData (
                entryName TEXT PRIMARY KEY,
                entryValue TEXT NOT NULL
            );
        `);
        const p = this.fileIndexDatabase.prepare;
        this.fileIndexQueries = {
            findKeys: p(`SELECT * FROM vectorKeys WHERE documentName = ?`),
            getKey: p(`SELECT * FROM vectorKeys WHERE vectorId = ?`),
            addKey: p(`INSERT INTO vectorKeys (vectorId,keyText,keyWeight,documentName) VALUES (? ? ? ?)`),
            removeKey: p(`DELETE FROM vectorKeys WHERE vectorId = ?`),
            getGlobal: p(`SELECT * FROM globalData WHERE entryName = ?`),
            setGlobal: p(`UPDATE globalData SET entryValue = ? WHERE entryName = ?`),
        };
        const presentGlobals = p<[], { entryName: string, entryValue: string }>(`SELECT * FROM globalData`).all().map(e => e.entryName);
        for (const name in DocumentDBDefaultGlobals) {
            const value = (DocumentDBDefaultGlobals as Record<string, unknown>)[name];
            if (typeof value !== "string") {
                throw new Error(`non-string value in DocumentDBDefaultGlobals[${JSON.stringify(name)}]`);
            }
            if (!presentGlobals.some(e => e === name)) {
                p<[string, string]>(`INSERT INTO globalData (entryName, entryValue) VALUES (? ?)`).run(name, value);
            }
        }
    }
    public async get(name: string, ensureExists?: false): Promise<StoredDocument<this, Payload> | null>;
    public async get(name: string, ensureExists: true): Promise<StoredDocument<this, Payload>>;
    public async get(name: string, ensureExists: boolean = false): Promise<StoredDocument<this, Payload> | null> {
        const file = path.join(this.folder, name + this.fileExtension);
        if (!await fs.exists(file)) {
            if (ensureExists) {
                throw new Error(`cannot find document ${JSON.stringify(name)} in DocumentDB on folder ${JSON.stringify(this.folder)}`);
            }
            return null;
        }
        const data = this.deserializeDocument(await fs.readFile(file, { encoding: this.fileEncoding }) as any);
        const vectorKeys = this.fileIndexQueries.findKeys.all(name).map(e => ({
            db: this,
            keyText: e.keyText,
            weight: e.keyWeight,
            vectorId: e.vectorId
        } as VectorKey<this, Payload>));
        return { db: this, data: { db: this, vectorKeys, content: data.content }, name };
    }
    public async add(name: string, content: Payload, keys: VectorKeyConstructor[]): Promise<StoredDocument<this, Payload>> {
        const file = path.join(this.folder, name + this.fileExtension);
        if (await fs.exists(file)) {
            throw new Error(`document ${JSON.stringify(name)} already exists in DocumentDB on folder ${JSON.stringify(this.folder)}`);
        }
        const data: DocumentData<this, Payload> = { db: this, content, vectorKeys: [] };
        await fs.writeFile(file, this.serializeDocument(data), { encoding: this.fileEncoding });
        await this.addKey(name, ...keys);
        return await this.get(name, true);
    }
    public async remove(name: string): Promise<StoredDocument<this, Payload>> {
        const document = await this.get(name, true);
        await this.removeKey(...document.data.vectorKeys);
        await fs.unlink(path.join(this.folder, name, this.fileExtension));
        return document;
    }
    public async update(name: string, content: Payload): Promise<StoredDocument<this, Payload>> {
        const document = await this.get(name, true);
        await this.remove(name);
        return await this.add(name, content, document.data.vectorKeys.map(e => ({ text: e.keyText, weight: e.weight })));
    }
    public async addKey(name: string, ...keys: VectorKeyConstructor[]): Promise<StoredDocument<this, Payload>> {
        const embeddings = (await this.embedder.embeddingBatched(keys.map(e => e.text))).map((e, i) => this.vectorNormalizer.normalize(e, keys[i]?.weight ?? 1));
        const lastVectorId = this.fileIndexQueries.getGlobal.get("lastVectorId")?.entryValue;
        if (lastVectorId === undefined) {
            throw new Error(`cannot find lastVectorId in globals of DocumentDB on folder ${JSON.stringify(this.folder)}`);
        }
        const startId = BigInt(lastVectorId) + 1n;
        const embeddingIds = embeddings.map((e, i) => startId + BigInt(i));
        this.vectorIndex.add(embeddingIds, embeddings);
        keys.forEach((key, i) => {
            const vectorId = embeddingIds[i] !== undefined ? String(embeddingIds[i]) : undefined;
            if (vectorId === undefined) {
                throw new Error(`troubles in getting correct vector id`);
            }
            this.fileIndexQueries.addKey.run(vectorId, key.text, key.weight, name);
        });
        return await this.get(name, true);
    }
    public async removeKey(...keys: VectorKeySelector[]): Promise<StoredDocument<this, Payload>> {
        for (const { vectorId } of keys) {
            this.fileIndexQueries.removeKey.run(vectorId);
        }
        this.vectorIndex.remove(keys.map(e => BigInt(e.vectorId)));
        throw new Error("Method not implemented.");
    }
    public async find(query: string, maxResults: number): Promise<FoundStoredDocument<this, Payload>[]> {
        const embedding = this.vectorNormalizer.normalize(await this.embedder.embedding(query));
        const { keys: vectorKeyIds, distances } = this.vectorIndex.search(embedding, maxResults, this.vectorIndexThreads);
        const documents = [...vectorKeyIds].map((keyId, i) => ({
            distance: distances[i],
            key: this.fileIndexQueries.getKey.get(String(keyId))
        }));
        const result: FoundStoredDocument<this, Payload>[] = [];
        for (const { distance, key } of documents) {
            if (distance === undefined) {
                throw new Error(`cannot find distance to one of search results`);
            }
            if (key === undefined) {
                throw new Error(`desynchronized vector and file index: cannot find documentName in file index for present key in vector index`);
            }
            result.push({
                document: await this.get(key.documentName, true),
                vectorId: key.vectorId,
                similarity: distance / key.keyWeight,
                distance,
            });
        }
        return result;
    }
}









//





