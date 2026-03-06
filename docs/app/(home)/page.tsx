import Link from "next/link"
import { TerminalFrame } from "@/components/landing/terminal-frame"
import { InstallCommand } from "@/components/landing/install-command"
import { RecipeCode } from "@/components/landing/recipe-code"
import { HeroToggle } from "@/components/landing/hero-toggle"
import {
  Server,
  Shield,
  TerminalSquare,
  Repeat,
  LayoutDashboard,
  Zap,
  FlaskConical,
} from "lucide-react"

const checkOutput = [
  { text: "$ ignition run --check deploy.ts admin@web-1", cls: "text-white font-semibold" },
  { text: "" },
  { text: "  web-1  ▸ Checking deploy.ts", cls: "text-terminal-blue" },
  { text: "" },
  { text: "  ✓  apt      nginx                  ok", cls: "text-terminal-dim" },
  { text: "  ~  dir      /var/www/app            would create", cls: "text-terminal-yellow" },
  { text: "  ~  file     /var/www/app/index.html would change", cls: "text-terminal-yellow" },
  { text: "  ✓  service  nginx                  ok", cls: "text-terminal-dim" },
  { text: "" },
  { text: "  4 resources: 2 would change, 2 ok", cls: "text-terminal-fg" },
  { text: "  dry-run complete ── no changes applied", cls: "text-terminal-green" },
]

const features = [
  {
    icon: TerminalSquare,
    title: "TypeScript Recipes",
    description:
      "Full language power. Loops, conditionals, type safety, and IDE autocomplete. No YAML.",
  },
  {
    icon: Shield,
    title: "Check Before Apply",
    description:
      "Every resource reads actual state before mutating. Dry-run for free with ignition run --check.",
  },
  {
    icon: Server,
    title: "Agentless",
    description: "Nothing to install on target hosts. Uses your system SSH binary directly.",
  },
  {
    icon: Repeat,
    title: "Idempotent",
    description:
      "Run recipes repeatedly. Only what needs changing gets changed. Already correct? No-op.",
  },
  {
    icon: LayoutDashboard,
    title: "Real-Time Dashboard",
    description: "Monitor automation runs across hosts in a live web UI. See status as it happens.",
  },
  {
    icon: Zap,
    title: "Parallel Execution",
    description: "Automate multiple hosts concurrently with a bounded worker pool.",
  },
]

export default function HomePage() {
  return (
    <main className="flex flex-col flex-1">
      {/* Experimental banner */}
      <div className="border-b border-brand/20 bg-brand/5">
        <div className="mx-auto max-w-250 flex items-center justify-center gap-2 px-4 py-2.5 text-sm">
          <FlaskConical className="size-4 text-brand shrink-0" />
          <span className="text-fd-muted-foreground">
            Ignition is <span className="font-medium text-fd-foreground">experimental</span> and
            under active development.{" "}
            <a
              href="https://github.com/grovemotorco/ignition"
              className="text-brand underline underline-offset-2 hover:opacity-80 transition-opacity"
            >
              Follow along on GitHub.
            </a>
          </span>
        </div>
      </div>

      {/* Hero */}
      <section className="px-4 pt-20 pb-16 md:px-8 md:pt-28 md:pb-24">
        <div className="mx-auto max-w-250 text-center">
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl lg:text-6xl">
            Server Automation
            <br />
            in <span className="text-brand">TypeScript</span>
          </h1>
          <p className="mt-5 text-lg text-fd-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Write server automation recipes as functions and push them over SSH.
          </p>

          <div className="mt-8 flex justify-center">
            <InstallCommand />
          </div>

          <div className="mt-5 flex items-center justify-center gap-4">
            <Link
              href="/docs"
              className="inline-flex items-center px-6 py-2.5 bg-brand text-brand-foreground font-medium text-sm hover:opacity-90 transition-opacity"
            >
              Get Started
            </Link>
            <a
              href="https://github.com/grovemotorco/ignition"
              className="inline-flex items-center px-6 py-2.5 border border-fd-border font-medium text-sm hover:bg-fd-accent transition-colors"
            >
              GitHub
            </a>
          </div>

          {/* Centered toggling recipe / terminal framed by bg video */}
          <div className="relative mt-12 mx-auto max-w-200 overflow-hidden">
            <video
              autoPlay
              muted
              loop
              playsInline
              className="absolute inset-0 size-full object-cover pointer-events-none"
              src="/bg0.mp4"
            />
            <div className="absolute inset-0 bg-fd-background/50 dark:bg-fd-background/60 pointer-events-none" />
            <div className="relative z-10 p-6 md:p-10">
              <div className="overflow-hidden border border-(--frame-border)">
                <HeroToggle />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Feature 1: TypeScript Recipes — text left, visual right */}
      <section className="px-4 py-16 md:px-8 lg:px-12 border-t border-fd-border">
        <div className="mx-auto max-w-300 overflow-hidden border border-fd-border bg-fd-card/50">
          <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr]">
            <div className="flex flex-col justify-center p-8 md:p-12">
              <h2 className="text-2xl font-bold tracking-tight md:text-3xl mb-3">
                TypeScript Recipes
              </h2>
              <p className="text-fd-muted-foreground leading-relaxed text-base md:text-lg">
                Write server automation logic in real TypeScript. No YAML, no DSL. Get full IDE
                autocomplete, type checking, conditionals, loops, and async/await. Import any npm
                package. Or use AI to write the recipe for you.
              </p>
            </div>
            <div className="relative overflow-hidden">
              <div
                className="absolute inset-0 bg-cover bg-center opacity-50 dark:opacity-30 pointer-events-none"
                style={{ backgroundImage: "url(/bg4.png)" }}
              />
              <div className="absolute inset-0 bg-fd-background/40 dark:bg-fd-background/50 pointer-events-none" />
              <div className="relative z-10 p-4 md:p-6">
                <TerminalFrame title="deploy.ts">
                  <RecipeCode />
                </TerminalFrame>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Feature 2: Check Before Apply — visual left, text right */}
      <section className="px-4 py-16 md:px-8 lg:px-12 border-t border-fd-border">
        <div className="mx-auto max-w-300 overflow-hidden border border-fd-border bg-fd-card/50">
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr]">
            <div className="relative overflow-hidden order-2 lg:order-1">
              <div
                className="absolute inset-0 bg-cover bg-center opacity-50 dark:opacity-30 pointer-events-none"
                style={{ backgroundImage: "url(/bg5.png)" }}
              />
              <div className="absolute inset-0 bg-fd-background/40 dark:bg-fd-background/50 pointer-events-none" />
              <div className="relative z-10 p-4 md:p-6">
                <TerminalFrame title="Terminal">
                  {checkOutput.map((line, i) => (
                    <div key={i} className={line.cls ?? "text-terminal-fg"}>
                      {line.text || "\u00A0"}
                    </div>
                  ))}
                </TerminalFrame>
              </div>
            </div>
            <div className="flex flex-col justify-center p-8 md:p-12 order-1 lg:order-2">
              <h2 className="text-2xl font-bold tracking-tight md:text-3xl mb-3">
                Check Before Apply
              </h2>
              <p className="text-fd-muted-foreground leading-relaxed text-base md:text-lg">
                Every resource reads actual server state before mutating anything. Run ignition
                check for a complete dry-run. See exactly what would change before applying.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Feature 3: Real-Time Dashboard — text left, visual right */}
      <section className="px-4 py-16 md:px-8 lg:px-12 border-t border-fd-border">
        <div className="mx-auto max-w-300 overflow-hidden border border-fd-border bg-fd-card/50">
          <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr]">
            <div className="flex flex-col justify-center p-8 md:p-12">
              <h2 className="text-2xl font-bold tracking-tight md:text-3xl mb-3">
                Real-Time Dashboard
              </h2>
              <p className="text-fd-muted-foreground leading-relaxed text-base md:text-lg">
                Monitor automation runs in a local, live web UI. Watch resources check and apply in
                real time, expand output per host, and catch failures during runs.
              </p>
            </div>
            <div className="relative overflow-hidden">
              <div
                className="absolute inset-0 bg-cover bg-center opacity-50 dark:opacity-30 pointer-events-none"
                style={{ backgroundImage: "url(/bg3.png)" }}
              />
              <div className="absolute inset-0 bg-fd-background/40 dark:bg-fd-background/50 pointer-events-none" />
              <div className="relative z-10 p-4 md:p-6">
                <div className="overflow-hidden border border-(--frame-border)">
                  {/* <Image
                    src="/media/dashboard-run.gif"
                    alt="Ignition dashboard showing a live automation run"
                    width={1280}
                    height={720}
                    className="w-full h-auto"
                    unoptimized
                  /> */}
                  <video
                    autoPlay
                    muted
                    loop
                    playsInline
                    width={1280}
                    height={720}
                    className="w-full h-auto"
                    src="/media/dashboard-run.mp4"
                    aria-label="Ignition dashboard showing a live automation run"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="px-4 py-20 md:px-8 lg:px-12 border-t border-fd-border">
        <div className="mx-auto max-w-300 overflow-hidden border border-fd-border bg-fd-card/50 p-6 md:p-10">
          <h2 className="text-2xl font-bold text-center mb-2 md:text-3xl">Why Ignition?</h2>
          <p className="text-fd-muted-foreground text-center mb-12 max-w-lg mx-auto">
            This is real. It works.
          </p>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div
                key={f.title}
                className="border border-fd-border bg-fd-background/60 p-6 hover:border-brand/30 transition-colors"
              >
                <div className="inline-flex items-center justify-center size-9 bg-brand/10 mb-4">
                  <f.icon className="size-5 text-brand" />
                </div>
                <h3 className="font-semibold mb-1.5">{f.title}</h3>
                <p className="text-sm text-fd-muted-foreground leading-relaxed">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="px-4 py-20 md:px-8 lg:px-12 border-t border-fd-border">
        <div className="mx-auto max-w-250">
          <h2 className="text-2xl font-bold text-center mb-2 md:text-3xl">How It Compares</h2>
          <p className="text-fd-muted-foreground text-center mb-12 max-w-lg mx-auto">
            You should probably use Ansible.
          </p>
          <div className="overflow-x-auto border border-fd-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-fd-border bg-fd-card/60 text-fd-muted-foreground">
                  <th className="py-3.5 px-5 text-left font-medium w-[180px]" />
                  <th className="py-3.5 px-5 text-center font-semibold text-brand">Ignition</th>
                  <th className="py-3.5 px-5 text-center font-medium">Ansible</th>
                  <th className="py-3.5 px-5 text-center font-medium">Chef / Puppet</th>
                </tr>
              </thead>
              <tbody className="text-fd-foreground/90">
                <tr className="border-b border-fd-border/40 hover:bg-fd-accent/30 transition-colors">
                  <td className="py-3.5 px-5 font-medium text-left">Production Ready</td>
                  <td className="py-3.5 px-5 text-center text-brand font-medium">Experimental</td>
                  <td className="py-3.5 px-5 text-center">Yes</td>
                  <td className="py-3.5 px-5 text-center text-fd-muted-foreground italic">
                    Does anyone still use it?
                  </td>
                </tr>
                <tr className="border-b border-fd-border/40 hover:bg-fd-accent/30 transition-colors">
                  <td className="py-3.5 px-5 font-medium text-left">Language</td>
                  <td className="py-3.5 px-5 text-center text-brand font-medium">TypeScript</td>
                  <td className="py-3.5 px-5 text-center">YAML</td>
                  <td className="py-3.5 px-5 text-center">Ruby / DSL</td>
                </tr>
                <tr className="border-b border-fd-border/40 hover:bg-fd-accent/30 transition-colors">
                  <td className="py-3.5 px-5 font-medium text-left">Agent required</td>
                  <td className="py-3.5 px-5 text-center">No (SSH)</td>
                  <td className="py-3.5 px-5 text-center">No (SSH)</td>
                  <td className="py-3.5 px-5 text-center">Yes</td>
                </tr>
                <tr className="border-b border-fd-border/40 hover:bg-fd-accent/30 transition-colors">
                  <td className="py-3.5 px-5 font-medium text-left">State files</td>
                  <td className="py-3.5 px-5 text-center">None</td>
                  <td className="py-3.5 px-5 text-center">None</td>
                  <td className="py-3.5 px-5 text-center">Server-side</td>
                </tr>
                <tr className="border-b border-fd-border/40 hover:bg-fd-accent/30 transition-colors">
                  <td className="py-3.5 px-5 font-medium text-left">Dry-run</td>
                  <td className="py-3.5 px-5 text-center">Built-in</td>
                  <td className="py-3.5 px-5 text-center">--check flag</td>
                  <td className="py-3.5 px-5 text-center">--why-run</td>
                </tr>
                <tr className="hover:bg-fd-accent/30 transition-colors">
                  <td className="py-3.5 px-5 font-medium text-left">IDE support</td>
                  <td className="py-3.5 px-5 text-center text-brand font-medium">
                    Full (native TS)
                  </td>
                  <td className="py-3.5 px-5 text-center">Limited</td>
                  <td className="py-3.5 px-5 text-center">Limited</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden border-t border-fd-border">
        <div
          className="absolute inset-0 bg-cover bg-center opacity-15 dark:opacity-10 pointer-events-none"
          style={{ backgroundImage: "url(/bg3.png)" }}
        />
        <div className="absolute inset-0 bg-linear-to-t from-fd-background to-fd-background/80" />
        <div className="relative z-10 px-4 py-20 md:px-8 lg:px-12">
          <div className="mx-auto max-w-150 text-center">
            <Link
              href="/docs/getting-started/installation"
              className="inline-flex items-center px-6 py-3 bg-brand text-brand-foreground font-medium hover:opacity-90 transition-opacity"
            >
              Read the Docs
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-fd-border px-4 py-6 md:px-8">
        <div className="mx-auto max-w-250 text-center text-sm text-fd-muted-foreground">
          <a
            href="https://www.grovemotor.co/"
            className="hover:text-fd-foreground transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            Grove Motor Engineering
          </a>
        </div>
      </footer>
    </main>
  )
}
