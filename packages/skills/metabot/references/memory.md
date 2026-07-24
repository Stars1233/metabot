# Meta Memory

```bash
metabot memory search "query"
metabot memory get <id|path>
metabot memory list [folder]
metabot memory create "title" "content" --share --tags a,b
metabot memory update <id> "content" [--share|--no-share]
metabot memory mkdir "name"
metabot memory health
```

Bare writes belong in the caller's namespace. Cross-agent reads require a
shared document or explicit access. Paths, visibility, and tags are separate.
