import type { ReactNode } from "react"

interface ContentSectionProps {
  variant: "centered" | "text-left" | "text-right"
  bgImage: string
  children: ReactNode
  title?: string
  subtitle?: string
  className?: string
}

export function ContentSection({
  variant,
  bgImage,
  children,
  title,
  subtitle,
  className = "",
}: ContentSectionProps) {
  if (variant === "centered") {
    return (
      <section className={`relative overflow-hidden ${className}`}>
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${bgImage})` }}
        />
        <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
        <div className="relative z-10 mx-auto max-w-225 px-4 py-16 md:px-8 md:py-24">
          {children}
        </div>
      </section>
    )
  }

  const textBlock = (
    <div className="flex flex-col justify-center py-8 lg:py-0">
      {title && <h2 className="text-2xl font-bold tracking-tight md:text-3xl mb-3">{title}</h2>}
      {subtitle && (
        <p className="text-fd-muted-foreground leading-relaxed text-base md:text-lg">{subtitle}</p>
      )}
    </div>
  )

  const terminalBlock = (
    <div className="relative">
      <div
        className="absolute inset-0 -m-6 bg-cover bg-center opacity-30 dark:opacity-20 pointer-events-none"
        style={{ backgroundImage: `url(${bgImage})` }}
      />
      <div className="absolute inset-0 -m-6 bg-linear-to-t from-fd-background/80 to-fd-background/40 dark:from-fd-background/90 dark:to-fd-background/50 pointer-events-none" />
      <div className="relative z-10">{children}</div>
    </div>
  )

  return (
    <section className={`px-4 py-16 md:px-8 lg:px-12 ${className}`}>
      <div className="mx-auto max-w-300 grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
        {variant === "text-left" ? (
          <>
            {textBlock}
            {terminalBlock}
          </>
        ) : (
          <>
            {terminalBlock}
            {textBlock}
          </>
        )}
      </div>
    </section>
  )
}
