# Environment

`sl_app` is a **Pure-WSL** project. Do all development — Claude Code sessions, `npm` commands, git operations — from inside the Ubuntu WSL distro, not from Windows against a WSL checkout. Running Claude Code from Windows over a `\\wsl.localhost\...` UNC path appears to work but introduces a long tail of friction: the git worktree `.git` file points at UNC paths, `.env` doesn't propagate into new worktrees, git identity must be re-set, and CRLF slips in through editors that don't honor `.gitattributes`. None of those problems exist if the tool and the checkout live on the same filesystem.

## One-time setup

1. **Install Claude Code inside WSL** (not Windows).
   ```bash
   # inside WSL
   npm install -g @anthropic-ai/claude-code
   ```

2. **Set your git identity inside WSL** — commits from the Windows-side Claude use Windows git config; they don't carry over.
   ```bash
   git config --global user.email "you@example.com"
   git config --global user.name  "Your Name"
   ```

3. **Use Node 20** to match CI. [.nvmrc](../.nvmrc) pins it.
   ```bash
   nvm use
   # or, first time:
   nvm install 20 && nvm use 20
   ```

4. **VS Code** (optional): use the **Remote-WSL** extension and "Open Folder in WSL" at `/home/tamachi/sl_app`. Don't open the UNC path from Windows VS Code.

## Daily flow

Open the project by launching Claude Code from a WSL shell:

```bash
wsl -d Ubuntu
cd /home/tamachi/sl_app
claude
```

The cwd becomes the Linux path, and everything Claude spawns inherits it. No `wsl -d Ubuntu -- bash -lc "cd ..."` incantations.

Tests and builds run directly:

```bash
npm test -- --run     # 139+ tests, single pass
npm run build         # production build → dist/
npm run dev           # vite on port 5173
```

## Creating a new worktree

Do this **from inside WSL** so the worktree's `.git` gitdir is a native Linux path:

```bash
cd /home/tamachi/sl_app
git worktree add ../sl_app_wt_featurename -b feature/name
cd ../sl_app_wt_featurename
ln -s /home/tamachi/sl_app/.env .env   # Supabase keys propagate
```

Verify the worktree is wired correctly:

```bash
cat .git
# → gitdir: /home/tamachi/sl_app/.git/worktrees/sl_app_wt_featurename
```

If you see `gitdir: //wsl.localhost/...` instead, the worktree was created from Windows — delete it and recreate from inside WSL.

Clean up when done:

```bash
git worktree remove ../sl_app_wt_featurename
```

## Why these files exist

- **[.gitattributes](../.gitattributes)** — `* text=auto eol=lf` so line endings stay LF regardless of which OS or editor checks out the tree. Prevents mixed-CRLF commits if someone opens the repo from Windows.
- **[.nvmrc](../.nvmrc)** — pins Node 20 to match `.github/workflows/*` (runs on `ubuntu-latest` with Node 20). `nvm use` in the repo root picks it up.
- **[.claude/launch.json](../.claude/launch.json)** — uses `"runtimeExecutable": "npm"` with `["run", "dev"]` so the dev server works from any worktree path. The previous `wsl -d Ubuntu -- bash -lc "cd /home/tamachi/sl_app && …"` baked in a specific Linux path and broke for worktrees.

## Gotchas

- **Don't edit files through `\\wsl.localhost\...` from a Windows editor mid-session.** Mixed access paths confuse file watchers (Vite HMR, Vitest) and can leave a second scrollbar in the `node_modules` state.
- **Don't create worktrees from Windows** (`git worktree add` from `\\wsl.localhost\...`). The gitdir stays UNC and every subsequent `git` call in that worktree is slower.
- **The `.env` symlink is required per-worktree.** Without it, Supabase calls fail at runtime with "supabaseUrl is required" — Vite reads `.env` from the project root only.
- **GitHub CLI auth lives per OS.** If you had `gh auth login` set up on Windows, run it again inside WSL.

## Migration from Windows-side Claude

If you were running Claude Code from Windows and want to switch:

1. Stop any running Windows-side Claude session.
2. Install Claude inside WSL (see step 1 above).
3. Set git identity inside WSL (step 2).
4. Delete any worktrees whose `.git` gitdir contains `//wsl.localhost/...` — they'll be slow forever. Recreate from inside WSL.
5. Confirm a test cycle works end-to-end: trivial edit → `npm test -- --run` → `git commit` → `git push`. No identity error, no CRLF warning, no `safe.directory` warning.
6. Remove the Windows Claude checkout once the WSL flow is confirmed.
