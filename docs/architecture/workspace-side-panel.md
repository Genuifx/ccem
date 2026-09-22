# Workspace side panel

The right side panel shares one resizable area between **Browser**, **Files** and
**Subagents**. The session review popover remains a compact summary. Its changed
files, artifacts and subagent entries open the corresponding side panel tab.
Switching tabs retains the browser instance and the selected file. Session and
working-directory changes select a separate panel state; stale preview responses
cannot replace a newer selection.

## File sources

- **Git changes** shows the current working directory's staged, unstaged and
  untracked files, including files inside newly created directories. It is not a
  session-specific change set: it can contain manual edits and other sessions'
  work. A session rooted in a repository subdirectory sees that subtree only.
- **Session writes** shows paths extracted from recorded Write, Edit, MultiEdit,
  NotebookEdit, apply_patch and file_change tool events. Known failed operations
  are excluded. Read operations and free-form tool result prose are not evidence
  of a write. Shell scripts and missing/pruned history may leave coverage gaps;
  an in-progress write can appear before its completion is known.
- **Browse files** uses the workspace file search, capped at 40 suggestions (the
  panel filters out directories).
  Narrow the search to find additional files. Search inherits the workspace
  search exclusions (such as .git and dependency/build directories).

The review's file count is the deduplicated union of Git and session paths. The
existing artifact count is an extension-based subset of those paths, not proof
that the files are finished deliverables. Neither count proves session ownership.

Git differences compare the working file to HEAD, including staged changes;
untracked files are compared with an empty file. File preview and source read the
current file on disk, including when viewing a historical conversation. There is
no saved before/after snapshot for each session.

## Links in conversation Markdown

Use a regular Markdown link with the dedicated in-app protocol:

```markdown
[Preview the report](ccem-file://preview?path=docs%2Freport.md)
```

The `path` query value is a URL-encoded workspace-relative or absolute local path.
The protocol is handled inside the workspace Markdown renderer; it is not an OS
deep link. Ordinary Markdown file links also work:

```markdown
[Report](docs/report.md)
[Report](/absolute/workspace/docs/report.md)
```

A Markdown file opens rendered by default; use **Source** or **Git diff** to
switch views. Links and local images inside a preview resolve relative to the
document's directory. Explicit `ccem-file:` paths resolve from the workspace.
Web links keep their existing external-browser behavior. Preview headings and
tables use the same Markdown renderer as conversation messages.

The backend canonicalizes paths and rejects directory traversal and symlinks
outside the session's working directory. Text preview works without Git, reads
at most 1 MiB, marks truncation, and reports binary or unreadable files. Local
images use the existing guarded media-preview command.

## Verification

`apps/desktop/test/workspace-side-panel-dom.test.mjs` drives the real React
components through review-to-panel navigation, Markdown/source/diff switching,
local links and images, browser retention, subagent transcript rendering, stale
response rejection, and browser activation rollback.

Rust tests in `workspace_file_preview.rs` use temporary non-Git directories and
real Git repositories for UTF-8/space/newline filenames, untracked directories,
subdirectory scope, diffs, text limits and workspace path boundaries. Desktop
smoke evidence lives in the task worktree's ignored `.artifacts/` directory.
