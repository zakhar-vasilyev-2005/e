
### About
This is some agent util, which I work on. Maybe later something.
Something.

### Files
Files in ./workspace:
1. `main-config.json` (or any other config extension, compatible with json/json5/ini/yaml/toml) (required) -- main config.
2. `main-config.schema.json` (output) -- file, which creates at start and contains json-schema for `main-config`.
3. `grammar/` -- a container for `.gbnf` files. All grammar entries are loaded from this folder.
4. `memo/facts/`, `memo/rules/` and `memo/tasks/` -- a vectorized document storage for facts, rules and tasks for agent.
5. `memo/*/file-index.sqlite3` -- information about vector keys stored in document storage. All vector keys (that are used in search process) are stored here.
6. `memo/*/vector-index.usearch` -- vector index file for fast vector search. Contains vectors without additional information to them, but allows fast search.
7. `memo/*/vector-index-config.json` -- config of created vector index. If this file differs with linked entry from `main-config`, then vector index is recreated.
8. `patterns/` -- a set of jinja patterns used to make a prompt/other text input chunk for AI. Doesn't affect the model's chat template, but rather affects the input chunks, used to construct `messages` in model's chat template.


