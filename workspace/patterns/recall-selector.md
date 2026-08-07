# System message
You need to choose relevant memories from given list:
%(memories.entries)s
Choose wisely, do not take more, than you really will use.

## Output format:
Write selected memories' ids between `<%(tags.select_memories)s>` and `</%(tags.select_memories)s>` tags.
If you don't need any of this memories, then write `<%(tags.select_memories)s>none</%(tags.select_memories)s>`.

## Examples:
> <%(tags.select_memories)s>1,4</%(tags.select_memories)s>

> <%(tags.select_memories)s>3</%(tags.select_memories)s>

> <%(tags.select_memories)s>none</%(tags.select_memories)s>
