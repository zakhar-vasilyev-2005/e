import fs from 'fs-extra';
import { parseINI, parseJSON5, parseTOML, parseYAML } from 'confbox'


/**
 * Reads config of INI, JSON5, Yaml or TOML content from file.
 * @param file is a string, representing an absolute path and ends with one of the following extensions: .ini, .cfg, .conf, .properties, .json,.jsonc, .json5, .yaml, .yml, .toml. Files without extension is threated as .ini.
 * @returns a value of type unknown
 */
export function readConfig(file: string) {
    const content = fs.readFileSync(file, { encoding: "utf8" });
    if (file.startsWith(".")) { file = file.slice(1); }
    const parts = file.split(".");
    const ext = parts.length < 2 ? ".ini" : "." + parts.at(-1);
    const parse = {
        ".ini": parseINI,
        ".cfg": parseINI,
        ".conf": parseINI,
        ".properties": parseINI,
        ".json": parseJSON5,
        ".jsonc": parseJSON5,
        ".json5": parseJSON5,
        ".yaml": parseYAML,
        ".yml": parseYAML,
        ".toml": parseTOML,
    }[ext] as (s: string) => unknown;
    return parse(content);
}

