import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared"

export const gitConfig = {
  user: "grovemotorco",
  repo: "ignition",
  branch: "main",
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <span className="font-semibold">Ignition</span>
        </>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  }
}
