import type { ReactNode } from "react"

const k = "text-syntax-keyword"
const t = "text-syntax-type"
const s = "text-syntax-string"
const f = "text-syntax-function"
const p = "text-syntax-punctuation"
const v = "text-syntax-variable"

function Line({ children }: { children?: ReactNode }) {
  return <div>{children ?? "\u00A0"}</div>
}

export function RecipeCode() {
  return (
    <div className="font-mono text-[13px] leading-[1.6] whitespace-pre">
      <Line>
        <span className={k}>import</span> <span className={k}>type</span>{" "}
        <span className={p}>{"{ "}</span>
        <span className={t}>ExecutionContext</span>
        <span className={p}>{" }"}</span> <span className={k}>from</span>{" "}
        <span className={s}>{'"@grovemotorco/ignition"'}</span>
      </Line>
      <Line>
        <span className={k}>import</span> <span className={p}>{"{ "}</span>
        <span className={f}>createResources</span>
        <span className={p}>{" }"}</span> <span className={k}>from</span>{" "}
        <span className={s}>{'"@grovemotorco/ignition"'}</span>
      </Line>
      <Line />
      <Line>
        <span className={k}>export default async function</span> <span className={p}>(</span>
        <span className={v}>ctx</span>
        <span className={p}>: </span>
        <span className={t}>ExecutionContext</span>
        <span className={p}>)</span> <span className={p}>{"{"}</span>
      </Line>
      <Line>
        {"  "}
        <span className={k}>const</span> <span className={p}>{"{ "}</span>
        <span className={v}>apt</span>
        <span className={p}>, </span>
        <span className={v}>file</span>
        <span className={p}>, </span>
        <span className={v}>directory</span>
        <span className={p}>, </span>
        <span className={v}>service</span>
        <span className={p}>{" }"}</span> <span className={p}>= </span>
        <span className={f}>createResources</span>
        <span className={p}>(</span>
        <span className={v}>ctx</span>
        <span className={p}>)</span>
      </Line>
      <Line />
      <Line>
        {"  "}
        <span className={k}>await</span> <span className={f}>apt</span>
        <span className={p}>({"{ "}</span>
        <span className={v}>name</span>
        <span className={p}>: </span>
        <span className={s}>{'"nginx"'}</span>
        <span className={p}>, </span>
        <span className={v}>state</span>
        <span className={p}>: </span>
        <span className={s}>{'"present"'}</span>
        <span className={p}>{" }"})</span>
      </Line>
      <Line />
      <Line>
        {"  "}
        <span className={k}>await</span> <span className={f}>directory</span>
        <span className={p}>({"{"}</span>
      </Line>
      <Line>
        {"    "}
        <span className={v}>path</span>
        <span className={p}>: </span>
        <span className={s}>{'"/var/www/app"'}</span>
        <span className={p}>,</span>
      </Line>
      <Line>
        {"    "}
        <span className={v}>owner</span>
        <span className={p}>: </span>
        <span className={s}>{'"www-data"'}</span>
        <span className={p}>,</span>
      </Line>
      <Line>
        {"    "}
        <span className={v}>mode</span>
        <span className={p}>: </span>
        <span className={s}>{'"755"'}</span>
        <span className={p}>,</span>
      </Line>
      <Line>
        {"  "}
        <span className={p}>{"}"})</span>
      </Line>
      <Line />
      <Line>
        {"  "}
        <span className={k}>await</span> <span className={f}>file</span>
        <span className={p}>({"{"}</span>
      </Line>
      <Line>
        {"    "}
        <span className={v}>path</span>
        <span className={p}>: </span>
        <span className={s}>{'"/var/www/app/index.html"'}</span>
        <span className={p}>,</span>
      </Line>
      <Line>
        {"    "}
        <span className={v}>content</span>
        <span className={p}>: </span>
        <span className={s}>{'"<h1>Hello from Ignition</h1>"'}</span>
        <span className={p}>,</span>
      </Line>
      <Line>
        {"    "}
        <span className={v}>owner</span>
        <span className={p}>: </span>
        <span className={s}>{'"www-data"'}</span>
        <span className={p}>,</span>
      </Line>
      <Line>
        {"  "}
        <span className={p}>{"}"})</span>
      </Line>
      <Line />
      <Line>
        {"  "}
        <span className={k}>await</span> <span className={f}>service</span>
        <span className={p}>({"{ "}</span>
        <span className={v}>name</span>
        <span className={p}>: </span>
        <span className={s}>{'"nginx"'}</span>
        <span className={p}>, </span>
        <span className={v}>state</span>
        <span className={p}>: </span>
        <span className={s}>{'"started"'}</span>
        <span className={p}>, </span>
        <span className={v}>enabled</span>
        <span className={p}>: </span>
        <span className={k}>true</span>
        <span className={p}>{" }"})</span>
      </Line>
      <Line>
        <span className={p}>{"}"}</span>
      </Line>
    </div>
  )
}
