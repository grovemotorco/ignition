type OGImageProps = {
  title?: string | undefined
  description?: string | undefined
  site?: string | undefined
}

/** Render the Open Graph image used for documentation pages. */
export function IgnitionOG({ title = "Ignition", description, site = "Ignition" }: OGImageProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: "#1e2a28",
        fontFamily: "Geist Sans, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          height: "5px",
          width: "100%",
          backgroundImage: "linear-gradient(to right, #c44d2b, #c44d2b 60%, #5aafa0)",
        }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          padding: "56px 72px 48px",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 52,
              fontWeight: 700,
              color: "#f0e4d0",
              lineHeight: 1.15,
              letterSpacing: "-0.02em",
              maxWidth: "90%",
            }}
          >
            {title}
          </div>
          {description ? (
            <div
              style={{
                display: "flex",
                fontSize: 24,
                color: "#8aaa90",
                lineHeight: 1.5,
                marginTop: 20,
                maxWidth: "75%",
              }}
            >
              {description}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: "1px solid rgba(240, 228, 208, 0.12)",
            paddingTop: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                display: "flex",
                width: 20,
                height: 20,
                backgroundColor: "#c44d2b",
                borderRadius: 3,
              }}
            />
            <span style={{ fontSize: 20, fontWeight: 600, color: "#f0e4d0" }}>{site}</span>
          </div>
          <span style={{ fontSize: 16, color: "#6a8a70" }}>Server Provisioning in TypeScript</span>
        </div>
      </div>
    </div>
  )
}
