# Project Rules & Agent Directives

## Subagent Swarm & Parallel Execution (MANDATORY)
- **Strict Ban on Sequential Reading**: NEVER read files one-by-one in the main thread (`view_file` loops).
- **Mandatory Subagent Dispatch**: For any multi-file feature, exploration, bug, or refactor, Step 1 MUST invoke 3–8 `research` subagents in parallel to investigate code concurrently.
- **Concurrent Editing**: When modifying multiple files, dispatch parallel `self` subagents (up to 15) to edit files simultaneously.
- **Zero Polling**: After `invoke_subagent`, stop calling tools immediately and rely on reactive wakeup.

## Code Exploration & Shell Safety
- **Strict Ban on Recursive Shell Grep**: NEVER run `Get-ChildItem -Recurse` or `dir /s`. They choke on `node_modules` and `.git`.
- **Primary Tool**: Use `codegraph` (`mcp_codegraph_codegraph_explore`) for all symbol, component, and file searches.
