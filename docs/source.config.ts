import { defineConfig, defineDocs } from "fumadocs-mdx/config"
import { metaSchema, pageSchema } from "fumadocs-core/source/schema"
import ignitionDark from "./theme/ignition-dark.json"
import ignitionLight from "./theme/ignition-light.json"

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
})

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        light: ignitionLight as never,
        dark: ignitionDark as never,
      },
    },
  },
})
