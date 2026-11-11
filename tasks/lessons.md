
## 2026-11-11: Plan files in shared worktrees require absolute mutation paths

A plan write combined with the shared workspace checker used the checker's root cwd and targeted root tasks/todo.md instead of this worktree twice. Always use an absolute worktree path for planning-file writes, and run the shared checker separately. An explicit workdir alone is insufficient when one command intentionally changes scope for the checker. Root owns recovery of any root-file mistakes; never overwrite preexisting root work to reconstruct it from Git.
