import type { ExecutionContext } from "@grovemotorco/ignition"
import { createResources } from "@grovemotorco/ignition"

export default async function (ctx: ExecutionContext): Promise<void> {
  const { exec } = createResources(ctx)

  const NVM = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'

  await exec({
    command: "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash",
  })

  await exec({
    command: "nvm install 24 && nvm alias default 24",
    shell: NVM,
    unless: "node --version | grep -q '^v24'",
  })

  await exec({
    command: "npm install -g @openai/codex",
    shell: NVM,
    unless: "command -v codex",
  })

  await exec({
    command: "node --version && npm --version && codex --version | head -1",
    shell: NVM,
    check: false,
  })
}
