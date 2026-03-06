/**
 * Example recipe: Set up a remote development environment.
 *
 * Installs essential development tools, modern CLI utilities, editors,
 * and AI coding assistants (Claude Code, OpenCode, Codex).
 *
 * Usage:
 *   ignition run   examples/dev-environment.ts root@10.0.1.5
 *   ignition run --check examples/dev-environment.ts root@10.0.1.5
 *
 *   # Specify a dev user:
 *   ignition run examples/dev-environment.ts root@10.0.1.5 --var dev_user=dev
 */

import type { ExecutionContext } from "../src/core/types.ts"
import { createResources } from "../src/resources/index.ts"

export const meta = {
  description: "Remote development environment with AI coding assistants",
  tags: ["dev", "tools", "ai"],
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { apt, exec, file, directory } = createResources(ctx)
  const devUser = (ctx.vars.dev_user as string) ?? "root"
  const home = devUser === "root" ? "/root" : `/home/${devUser}`

  // ── Create dev user if not root ──────────────────────────────────────
  if (devUser !== "root") {
    await exec({
      command: `useradd --create-home --shell /bin/bash ${devUser}`,
      unless: `id -u ${devUser}`,
      sudo: true,
    })
  }

  // ── System packages ──────────────────────────────────────────────────
  await apt({
    name: [
      // Build essentials
      "build-essential",
      "pkg-config",
      "libssl-dev",
      // Core tools
      "git",
      "curl",
      "wget",
      "unzip",
      "jq",
      // Terminal utilities
      "tmux",
      "htop",
      "tree",
      // Modern CLI tools (Ubuntu repos)
      "ripgrep",
      "fd-find",
      // Python (often needed for tooling)
      "python3",
      "python3-pip",
    ],
    state: "present",
    update: true,
  })

  // ── fzf (fuzzy finder) ──────────────────────────────────────────────
  await exec({
    command: `git clone --depth 1 https://github.com/junegunn/fzf.git ${home}/.fzf && ${home}/.fzf/install --all --no-update-rc`,
    unless: `test -d ${home}/.fzf`,
    sudo: devUser !== "root",
  })

  // ── Neovim (latest stable via AppImage) ─────────────────────────────
  await exec({
    command:
      "curl -fsSL -o /usr/local/bin/nvim https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.appimage && chmod +x /usr/local/bin/nvim",
    unless: "command -v nvim",
    sudo: true,
  })

  // ── Node.js 24 LTS (required for Claude Code and npm-based tools) ──
  await exec({
    command: "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -",
    unless: "test -f /etc/apt/sources.list.d/nodesource.list",
    sudo: true,
  })
  await apt({ name: "nodejs", state: "present" })

  // ── Go (required for opencode build, useful for general dev) ────────
  await exec({
    command: "curl -fsSL https://go.dev/dl/go1.23.6.linux-amd64.tar.gz | tar -C /usr/local -xzf -",
    unless: "command -v go",
    sudo: true,
  })

  // Ensure Go is on PATH
  await file({
    path: "/etc/profile.d/golang.sh",
    content: "export PATH=$PATH:/usr/local/go/bin\nexport PATH=$PATH:$HOME/go/bin\n",
    mode: "644",
  })

  // ── AI coding assistants ─────────────────────────────────────────────

  // Claude Code (Anthropic) — native installer
  await exec({
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    unless: "command -v claude",
    sudo: devUser !== "root",
  })

  // OpenCode — install script
  await exec({
    command: "curl -fsSL https://opencode.ai/install | bash",
    unless: "command -v opencode",
    sudo: devUser !== "root",
  })

  // Codex (OpenAI) — npm global install
  await exec({
    command: "npm install -g @openai/codex",
    unless: "command -v codex",
    sudo: true,
  })

  // ── Git configuration ────────────────────────────────────────────────
  const gitName = (ctx.vars.git_name as string) ?? ""
  const gitEmail = (ctx.vars.git_email as string) ?? ""

  if (gitName) {
    await exec({ command: `git config --global user.name "${gitName}"`, sudo: devUser !== "root" })
  }
  if (gitEmail) {
    await exec({
      command: `git config --global user.email "${gitEmail}"`,
      sudo: devUser !== "root",
    })
  }

  // ── Dev workspace ────────────────────────────────────────────────────
  await directory({ path: `${home}/projects`, owner: devUser, group: devUser, mode: "755" })

  // ── Shell configuration ──────────────────────────────────────────────
  await file({
    path: `${home}/.bashrc.d/dev-tools.sh`,
    content: `# Dev environment paths and aliases
export PATH="$PATH:/usr/local/go/bin:$HOME/go/bin:$HOME/.local/bin:$HOME/.fzf/bin"

# Aliases
alias vim="nvim"
alias g="git"
alias gs="git status"
alias gd="git diff"
alias gl="git log --oneline -20"
alias ll="ls -alh"

# fzf
[ -f ~/.fzf.bash ] && source ~/.fzf.bash
`,
    owner: devUser,
    group: devUser,
    mode: "644",
  })

  // Ensure .bashrc sources .bashrc.d
  await directory({ path: `${home}/.bashrc.d`, owner: devUser, group: devUser, mode: "755" })
  await exec({
    command: `grep -q 'bashrc.d' ${home}/.bashrc 2>/dev/null || echo -e '\\n# Source custom scripts\\nfor f in ~/.bashrc.d/*.sh; do [ -r "$f" ] && . "$f"; done' >> ${home}/.bashrc`,
  })

  // ── Summary ──────────────────────────────────────────────────────────
  await exec({
    command:
      "echo '=== Installed versions ===' && node --version && npm --version && go version && nvim --version | head -1 && git --version",
    check: false,
  })
}
