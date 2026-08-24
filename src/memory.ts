import path from "path";
import fs from 'fs-extra';
import type { Serializable } from "./serializable.js";
import { Index, MetricKind, ScalarKind, type IndexConfig } from 'usearch';
import * as sqlite3 from 'better-sqlite3';
import * as z from 'zod';
import { type Embedder } from "./embedder.js";
import type { VectorNormalizer } from "./vector-normalizer.js";
import { getFileTree } from "./get-file-tree.js";



type PromiseOrNot<T> = Promise<T> | T;

export interface BaseDB<Payload extends Serializable, KeyPayload extends Serializable> {
    folder: string,
    get(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, ensureExists?: false): PromiseOrNot<StoredDocument<this, Payload, KeyPayload> | null>;
    get(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, ensureExists: true): PromiseOrNot<StoredDocument<this, Payload, KeyPayload>>;
    get(document: StoredDocument<this, Payload, KeyPayload>, ensureExists?: boolean): PromiseOrNot<StoredDocument<this, Payload, KeyPayload>>;
    get(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, ensureExists?: boolean): PromiseOrNot<StoredDocument<this, Payload, KeyPayload> | null>;
    add(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, content: Payload, keys: VectorKeyConstructor<KeyPayload>[]): PromiseOrNot<StoredDocument<this, Payload, KeyPayload>>;
    removeKeys(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, ...keys: VectorKeySelector[]): PromiseOrNot<StoredDocument<this, Payload, KeyPayload>>;
    remove(name: string, skipIfNotExist?: false): PromiseOrNot<StoredDocument<this, Payload, KeyPayload>>;
    remove(name: string, skipIfNotExist: true): PromiseOrNot<StoredDocument<this, Payload, KeyPayload> | null>;
    remove(document: StoredDocument<this, Payload, KeyPayload>, skipIfNotExist?: boolean): PromiseOrNot<StoredDocument<this, Payload, KeyPayload>>;
    remove(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, skipIfNotExist?: boolean): PromiseOrNot<StoredDocument<this, Payload, KeyPayload> | null>;
    update(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, updates: DocumentUpdates<Payload, KeyPayload>): PromiseOrNot<StoredDocument<this, Payload, KeyPayload>>;
    find(query: string, maxResults: number): PromiseOrNot<FoundStoredDocument<this, Payload, KeyPayload>[]>;
    list(): PromiseOrNot<string[]>;
};
export type VectorKeyConstructor<KeyPayload extends Serializable> = {
    weight: number,
    text: string,
    payload: KeyPayload,
};
export type VectorKey<DocumentDB extends BaseDB<Payload, KeyPayload>, Payload extends Serializable, KeyPayload extends Serializable> = {
    db: DocumentDB,
    keyText: string,
    weight: number,
    vectorId: string,
    keyPayload: KeyPayload,
};
export interface VectorKeySelector {
    vectorId: string,
};
export type DocumentDataConstructor<Payload extends Serializable, KeyPayload extends Serializable> = {
    vectorKeys: VectorKeyConstructor<KeyPayload>[],
    content: Payload,
};
export type DocumentData<DocumentDB extends BaseDB<Payload, KeyPayload>, Payload extends Serializable, KeyPayload extends Serializable> = {
    db: DocumentDB,
    vectorKeys: VectorKey<DocumentDB, Payload, KeyPayload>[],
    content: Payload,
};
export type StoredDocument<DocumentDB extends BaseDB<Payload, KeyPayload>, Payload extends Serializable, KeyPayload extends Serializable> = {
    db: DocumentDB,
    name: string,
    data: DocumentData<DocumentDB, Payload, KeyPayload>,
};
export type FoundStoredDocument<DocumentDB extends BaseDB<Payload, KeyPayload>, Payload extends Serializable, KeyPayload extends Serializable> = {
    document: StoredDocument<DocumentDB, Payload, KeyPayload>,
    similarity: number,
    distance: number,
    key: VectorKey<DocumentDB, Payload, KeyPayload>
};
export type DocumentUpdates<Payload extends Serializable, KeyPayload extends Serializable> = {
    content?: Payload | undefined,
    keys?: VectorKeyConstructor<KeyPayload>[] | undefined,
    keyUpdates?: (VectorKeySelector & {
        payload?: KeyPayload | undefined,
        weight?: number | undefined,
    })[],
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
    keyEmbedding: string,
    keyWeight: number,
    documentName: string
    keyPayload: string,
};
export type DocumentDBParams<Payload extends Serializable, KeyPayload extends Serializable, Encoding extends BufferEncoding | null> = {
    embedder: Embedder,
    vectorNormalizer: VectorNormalizer,
    mainFolder: string,
    vectorIndexConfig: Omit<Omit<IndexConfig, "metric">, "dimensions">,
    vectorIndexThreads: number,
    fileExtension: string,
    fileEncoding: Encoding,
    serialize: (
        this: DocumentDB<Payload, KeyPayload, Encoding>,
        data: DocumentData<DocumentDB<Payload, KeyPayload, Encoding>, Payload, KeyPayload>
    ) => Encoding extends "binary" ? Uint8Array : string,
    deserialize: (
        this: DocumentDB<Payload, KeyPayload, Encoding>,
        data: Encoding extends "binary" ? Buffer : string
    ) => DocumentDataConstructor<Payload, KeyPayload>,
    validator: (
        this: DocumentDB<Payload, KeyPayload, Encoding>,
        data: StoredDocument<DocumentDB<Payload, KeyPayload, Encoding>, Payload, KeyPayload>
    ) => PromiseOrNot<{ valid: boolean, message?: string }>,
};
export const DocumentDBDefaultGlobals = {
    lastVectorId: "1",
};
export type DocumentDBGlobalsEntry = {
    entryName: string,
    entryValue: string,
};
export class DocumentDB<Payload extends Serializable, KeyPayload extends Serializable, Encoding extends BufferEncoding | null> implements BaseDB<Payload, KeyPayload> {
    public readonly vectorIndex: Index;
    public readonly vectorIndexFile: string;
    public readonly vectorIndexConfigFile: string;
    public readonly vectorIndexThreads: number;
    public readonly fileIndexDatabase: sqlite3.Database;
    public readonly fileIndexDatabaseFile: string;
    public readonly fileIndexQueries: {
        findKeys: (documentName: string) => DocumentDBVectorKeyEntry[],
        getKey: (vectorId: string) => DocumentDBVectorKeyEntry | undefined,
        addKey: (key: DocumentDBVectorKeyEntry) => void,
        updateKey: (key: DocumentDBVectorKeyEntry) => void,
        removeKey: (vectorId: string) => void,
        getGlobal: (entryName: string) => DocumentDBGlobalsEntry | undefined,
        setGlobal: (entry: DocumentDBGlobalsEntry) => void,
    };
    public readonly folder: string;
    public readonly vectorIndexConfig: Omit<IndexConfig, "metric">;
    public readonly fileExtension: string;
    public readonly fileEncoding: Encoding;
    public readonly embedder: Embedder;
    public readonly vectorNormalizer: VectorNormalizer;
    public readonly fnSerializer: DocumentDBParams<Payload, KeyPayload, Encoding>["serialize"];
    public readonly fnDeserializer: DocumentDBParams<Payload, KeyPayload, Encoding>["deserialize"];
    public readonly fnValidator: DocumentDBParams<Payload, KeyPayload, Encoding>["validator"];
    public constructor(params: DocumentDBParams<Payload, KeyPayload, Encoding>) {
        this.folder = params.mainFolder;
        this.vectorIndexThreads = params.vectorIndexThreads;
        this.vectorIndexConfig = Object.freeze(Object.assign({ dimensions: params.embedder.modelInfo.meta.n_embd }, params.vectorIndexConfig));
        this.fnSerializer = params.serialize;
        this.fnDeserializer = params.deserialize;
        this.fnValidator = params.validator;
        this.fileEncoding = params.fileEncoding;
        this.fileExtension = params.fileExtension;
        this.embedder = params.embedder;
        this.vectorNormalizer = params.vectorNormalizer;
        fs.ensureDirSync(this.folder);
        this.vectorIndexFile = path.join(this.folder, "vector-index.usearch");
        this.vectorIndexConfigFile = path.join(this.folder, "vector-index-config.json");
        this.fileIndexDatabaseFile = path.join(this.folder, "file-index.sqlite3");
        const exists = {
            [this.vectorIndexFile]: fs.existsSync(this.vectorIndexFile),
            [this.vectorIndexConfigFile]: fs.existsSync(this.vectorIndexConfigFile),
            [this.fileIndexDatabaseFile]: fs.existsSync(this.fileIndexDatabaseFile),
        };
        if (Object.values(exists).some(e => (!!e) === false)) {
            Object.keys(exists).filter(e => exists[e]).forEach(e => fs.unlinkSync(e));
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
        this.fileIndexDatabase = new sqlite3.default(this.fileIndexDatabaseFile, { fileMustExist: false });
        this.fileIndexDatabase.exec(`
            CREATE TABLE IF NOT EXISTS vectorKeys (
                vectorId TEXT PRIMARY KEY,
                keyText TEXT NOT NULL,
                keyEmbedding TEXT NOT NULL,
                keyWeight REAL NOT NULL,
                documentName TEXT NOT NULL,
                keyPayload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS globalData (
                entryName TEXT PRIMARY KEY,
                entryValue TEXT NOT NULL
            );
        `);
        const db = this.fileIndexDatabase;
        const op = <T extends unknown[], R>(pattern: string, func: (s: sqlite3.Statement) => (...args: T) => R) => func(db.prepare(pattern));
        this.fileIndexQueries = {
            findKeys: op(`SELECT * FROM vectorKeys WHERE documentName = ?`, s => name => s.all(name) as DocumentDBVectorKeyEntry[]),
            getKey: op(`SELECT * FROM vectorKeys WHERE vectorId = ?`, s => id => s.get(id) as DocumentDBVectorKeyEntry | undefined),
            addKey: op(`INSERT INTO vectorKeys (vectorId,keyText,keyEmbedding,keyWeight,documentName,keyPayload) VALUES (?, ?, ?, ? ?)`, s => key => s.run(key.vectorId, key.keyText, key.keyWeight, key.documentName, key.keyPayload)),
            updateKey: op(`UPDATE vectorKeys SET keyText = ?, keyEmbedding = ?, keyWeight = ?, documentName = ?, keyPayload = ? WHERE vectorId = ?`, s => key => s.all(key.keyText, key.keyEmbedding, key.keyWeight, key.documentName, key.keyPayload, key.vectorId)),
            removeKey: op(`DELETE FROM vectorKeys WHERE vectorId = ?`, s => id => s.run(id)),
            getGlobal: op(`SELECT * FROM globalData WHERE entryName = ?`, s => name => s.get(name) as DocumentDBGlobalsEntry | undefined),
            setGlobal: op(`UPDATE globalData SET entryValue = ? WHERE entryName = ?`, s => e => s.run(e.entryValue, e.entryName)),
        };
        const presentGlobals = db.prepare<[], { entryName: string, entryValue: string }>(`SELECT * FROM globalData`).all().map(e => e.entryName);
        for (const name in DocumentDBDefaultGlobals) {
            const value = (DocumentDBDefaultGlobals as Record<string, unknown>)[name];
            if (typeof value !== "string") {
                throw new Error(`non-string value in DocumentDBDefaultGlobals[${JSON.stringify(name)}]`);
            }
            if (!presentGlobals.some(e => e === name)) {
                db.prepare<[string, string]>(`INSERT INTO globalData (entryName, entryValue) VALUES (?, ?)`).run(name, value);
            }
        }
    }
    public async get(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, ensureExists?: false): Promise<StoredDocument<this, Payload, KeyPayload> | null>;
    public async get(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, ensureExists: true): Promise<StoredDocument<this, Payload, KeyPayload>>;
    public async get(document: StoredDocument<this, Payload, KeyPayload>, ensureExists?: boolean): Promise<StoredDocument<this, Payload, KeyPayload>>;
    public async get(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, ensureExists: boolean = false): Promise<StoredDocument<this, Payload, KeyPayload> | null> {
        if (typeof nameOrDocument !== "string") {
            return nameOrDocument;
        }
        const name = nameOrDocument;
        const file = path.join(this.folder, name + this.fileExtension);
        if (!await fs.exists(file)) {
            if (ensureExists) {
                throw new Error(`cannot find document ${JSON.stringify(name)} in DocumentDB on folder ${JSON.stringify(this.folder)}`);
            }
            return null;
        }
        const content = await fs.readFile(file, { encoding: this.fileEncoding });
        const vectorKeys = this.fileIndexQueries.findKeys(name).map(e => ({
            db: this,
            keyText: e.keyText,
            weight: e.keyWeight,
            vectorId: e.vectorId,
            keyPayload: JSON.parse(e.keyPayload) as any,
        } as VectorKey<this, Payload, KeyPayload>));
        let data: DocumentDataConstructor<Payload, KeyPayload>;
        try {
            data = this.fnDeserializer(content as any);
        } catch (e) {
            throw e;
        }
        return { db: this, data: { db: this, vectorKeys, content: data.content }, name };
    }
    public nameOf(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>): string {
        if (typeof nameOrDocument === "string") {
            return nameOrDocument;
        } else {
            return nameOrDocument.name;
        }
    }
    public fileOf(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>): string {
        return path.join(this.folder, this.nameOf(nameOrDocument) + this.fileExtension);
    }
    public pullVectorIds(count: number): bigint[] {
        if (count <= 0) {
            return [];
        }
        const lastVectorId = this.fileIndexQueries.getGlobal("lastVectorId")?.entryValue;
        if (lastVectorId === undefined) {
            throw new Error(`cannot find lastVectorId in globals of DocumentDB on folder ${JSON.stringify(this.folder)}`);
        }
        const startId = BigInt(lastVectorId) + 1n;
        const vectorIds = Array.from({ length: count }, (e, i) => startId + BigInt(i));
        this.fileIndexQueries.setGlobal({ entryName: "lastVectorId", entryValue: String(vectorIds.at(-1) as bigint) });
        return vectorIds;
    }
    public async add(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, content: Payload, keys: VectorKeyConstructor<KeyPayload>[]): Promise<StoredDocument<this, Payload, KeyPayload>> {
        const name = this.nameOf(nameOrDocument);
        const file = this.fileOf(name);
        if (await fs.exists(file)) {
            throw new Error(`document ${JSON.stringify(name)} already exists in DocumentDB on folder ${JSON.stringify(this.folder)}`);
        }
        const data: DocumentData<this, Payload, KeyPayload> = { db: this, content, vectorKeys: [] };
        if (keys.length !== 0) {
            const embeddings = (await this.embedder.embeddingBatched(keys.map(e => e.text))).map((e, i) => this.vectorNormalizer.normalize(e, keys[i]?.weight ?? 1));
            const embeddingIds = this.pullVectorIds(embeddings.length);
            this.vectorIndex.add(embeddingIds, embeddings);
            keys.forEach((key, i) => {
                const vectorId = embeddingIds[i] !== undefined ? String(embeddingIds[i]) : undefined;
                if (vectorId === undefined) {
                    throw new Error(`troubles in getting correct vector id`);
                }
                this.fileIndexQueries.addKey({
                    vectorId,
                    keyText: key.text,
                    keyEmbedding: JSON.stringify(embeddings[i]),
                    keyWeight: key.weight,
                    documentName: name,
                    keyPayload: JSON.stringify(key.payload)
                });
                data.vectorKeys.push({ db: this, keyText: key.text, vectorId, weight: key.weight, keyPayload: key.payload });
            });
        }
        await fs.writeFile(file, this.fnSerializer(data), { encoding: this.fileEncoding });
        return await this.validate(name);
    }
    public async validate(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>) {
        const document = await this.get(nameOrDocument, true);
        const { valid, message } = await this.fnValidator(document);
        if (!valid) {
            await this.remove(document);
            throw Object.assign(new Error(`cannot add document: ${message ?? "document not valid"}`), {
                error: "VALIDATION_ERROR",
                document,
                validationMessage: message
            });
        }
        return document;
    }
    public async removeKeys(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, ...keys: VectorKeySelector[]): Promise<StoredDocument<this, Payload, KeyPayload>> {
        const document = await this.get(nameOrDocument, true);
        for (const { vectorId } of keys) {
            this.fileIndexQueries.removeKey(vectorId);
        }
        this.vectorIndex.remove(keys.map(e => BigInt(e.vectorId)));
        document.data.vectorKeys = document.data.vectorKeys.filter(key => !keys.some(e => e.vectorId === key.vectorId));
        return await this.updateFile(document, document.data);
    }
    public async updateFile(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, data: DocumentData<this, Payload, KeyPayload>): Promise<StoredDocument<this, Payload, KeyPayload>> {
        await fs.writeFile(this.fileOf(nameOrDocument), this.fnSerializer(data), { encoding: this.fileEncoding });
        return this.get(nameOrDocument, true);
    }
    public async remove(name: string, skipIfNotExist?: false): Promise<StoredDocument<this, Payload, KeyPayload>>;
    public async remove(name: string, skipIfNotExist: true): Promise<StoredDocument<this, Payload, KeyPayload> | null>;
    public async remove(document: StoredDocument<this, Payload, KeyPayload>, skipIfNotExist?: boolean): Promise<StoredDocument<this, Payload, KeyPayload>>;
    public async remove(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, skipIfNotExist: boolean = false): Promise<StoredDocument<this, Payload, KeyPayload> | null> {
        const name = this.nameOf(nameOrDocument);
        const document = await this.get(nameOrDocument, false);
        if (document === null) {
            if (skipIfNotExist) {
                return null;
            } else {
                throw new Error(`cannot find document ${JSON.stringify(name)} in DocumentDB on folder ${JSON.stringify(this.folder)}`);
            }
        }
        await this.removeKeys(document, ...document.data.vectorKeys);
        await fs.unlink(this.fileOf(document));
        return document;
    }
    public async update(nameOrDocument: string | StoredDocument<this, Payload, KeyPayload>, updates: DocumentUpdates<Payload, KeyPayload>): Promise<StoredDocument<this, Payload, KeyPayload>> {
        const document = await this.get(nameOrDocument, true);
        if (updates.keys !== undefined) {
            await this.removeKeys(document, ...document.data.vectorKeys);
        } else {
            const keyUpdates = (updates.keyUpdates ?? []).filter(e => e.payload !== undefined || e.weight !== undefined);
            const keys = keyUpdates.map(e => {
                const key = this.fileIndexQueries.getKey(e.vectorId);
                if (key === undefined) {
                    throw new Error(`cannot find key with vectorId=${JSON.stringify(e.vectorId)}`);
                }
                this.fileIndexQueries.updateKey({
                    vectorId: e.vectorId,
                    documentName: document.name,
                    keyText: key.keyText,
                    keyEmbedding: key.keyEmbedding,
                    keyWeight: e.weight ?? key.keyWeight,
                    keyPayload: e.payload !== undefined ? JSON.stringify(e.payload) : key.keyPayload,
                });
                return { update: e, key };
            });
            const weightKeys = keys.filter(e => e.update.weight !== undefined);
            if (weightKeys.length !== 0) {
                this.vectorIndex.remove(weightKeys.map(e => BigInt(e.key.vectorId)));
                this.vectorIndex.add(
                    weightKeys.map(e => BigInt(e.key.vectorId)),
                    weightKeys.map(e => {
                        const c = (e.update.weight ?? e.key.keyWeight) / e.key.keyWeight;
                        return new Float32Array(JSON.parse(e.key.keyEmbedding)).map(f => f * c);
                    })
                );
            }
        }
        return await this.updateFile(document, Object.assign(document.data, { content: updates.content ?? document.data.content }));
    }
    public async find(query: string, maxResults: number): Promise<FoundStoredDocument<this, Payload, KeyPayload>[]> {
        if (maxResults <= 0) { return []; }
        const embedding = this.vectorNormalizer.normalize(await this.embedder.embedding(query));
        const { keys: vectorKeyIds, distances } = this.vectorIndex.search(embedding, maxResults, this.vectorIndexThreads);
        const documents = [...vectorKeyIds].map((keyId, i) => ({
            distance: distances[i],
            key: this.fileIndexQueries.getKey(String(keyId))
        }));
        const result: FoundStoredDocument<this, Payload, KeyPayload>[] = [];
        for (const { distance, key } of documents) {
            if (distance === undefined) {
                throw new Error(`cannot find distance to one of search results`);
            }
            if (key === undefined) {
                throw new Error(`desynchronized vector and file index: cannot find documentName in file index for present key in vector index`);
            }
            result.push({
                document: await this.get(key.documentName, true),
                similarity: distance / key.keyWeight,
                distance,
                key: {
                    db: this,
                    vectorId: key.vectorId,
                    keyText: key.keyText,
                    weight: key.keyWeight,
                    keyPayload: JSON.parse(key.keyPayload) as any,
                }
            });
        }
        return result;
    }
    public async list(): Promise<string[]> {
        const tree = await getFileTree(this.folder);
        return tree.map(file => {
            const name = file.slice(this.folder.length);
            return name.startsWith(path.sep) ? name.slice(1) : name;
        }).filter(e => e.endsWith(this.fileExtension)).map(e => e.slice(0, -this.fileExtension.length));
    }
}









//





