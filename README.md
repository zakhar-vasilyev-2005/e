
### About
This is some agent util, which I work on. Maybe later something.
Something.

### Files
Files in ./workspace:
1. `main-config[any config extension, compatible with json/json5/ini/yaml/toml]` (required) -- main config.
2. `system-prompt.md` (required) -- the only system prompt, used by agent.
3. `memory-ids.json` (optional, creates on start) -- link between vector ids and filenames vector refers to.
4. `server-socket.sock` (optional, creates on start) -- unix-socket of main inference server; independent with core agent script.
5. `vector-index.meta.json` (optional, creates on start) -- saved params of vector index; if this is different with the params from `main-config`, then vector index recreates.
6. `vector-index.usearch` (optional, creates on start) -- vector index, created from 'key' sections, obtained from `.memo.md` and `.rule.md` from ./workspaces/memo.
7. `memo/**.fact.md` -- memories and facts.
8. `memo/**.rule.md` -- rules and skills for agent.
9. `memo/**.task.md` -- tasks of agent.




