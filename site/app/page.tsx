import Image from 'next/image';
import { DownloadSimple, GithubLogo, Graph } from '@phosphor-icons/react/dist/ssr';
import { CopyCommand } from './copy-command';

const repository = 'https://github.com/Imhaohao/context-master';
const latest = `${repository}/releases/latest/download`;
const install = `curl -fsSL ${latest}/install.sh | sh`;
const connect = "claude mcp add --scope user context-master -e ELECTRON_RUN_AS_NODE=1 -- '/Applications/Context Master.app/Contents/MacOS/Context Master' '/Applications/Context Master.app/Contents/Resources/agent/mcp.cjs'";
const ask = 'claude -p "A student was charged once but got two confirmation emails. Ask the right context-master specialist why."';

const tools = [
  { name: 'search_specialists', does: 'Ranks your specialists by how well their saved chats match a question.' },
  { name: 'ask_specialist', does: 'Asks one specialist. It answers through your Claude Code or Codex login and cites the saved messages it used.' },
  { name: 'get_specialist_context', does: 'Returns the specialist’s brief and up to six source excerpts without calling a model.' },
  { name: 'get_consultation', does: 'Reads back an earlier answer with its sources.' },
];

const privacy = [
  { thing: 'Imported chats and specialists', where: 'A SQLite file in ~/Library/Application Support/Context Master that only your user can read.' },
  { thing: 'Your original chat files', where: 'Read once when you import them. They are never changed, resumed or deleted.' },
  { thing: 'An ask_specialist call', where: 'Sends the brief, the question and up to six excerpts to the model behind the CLI you chose.' },
  { thing: 'A get_specialist_context call', where: 'Nothing leaves the Mac. The calling agent reads the excerpts itself.' },
];

export default function Home() {
  return <>
    <header className="page flex h-16 items-center justify-between">
      <span className="flex items-center gap-2 font-medium"><Graph size={24} weight="light" aria-hidden="true" />Context Master</span>
      <a className="flex items-center gap-2 text-sm no-underline" href={repository}><GithubLogo size={18} aria-hidden="true" />Source on GitHub</a>
    </header>

    <main>
      <section className="page grid gap-10 pt-12 pb-16 md:pt-20">
        <div className="rise grid max-w-3xl gap-6">
          <h1 className="text-4xl font-semibold leading-tight md:text-5xl">Turn old coding chats into specialists your agents can ask</h1>
          <p className="lede">Pick the chats worth keeping. Claude Code, Codex and other MCP agents can then ask them what you already solved.</p>
          <div className="grid gap-3">
            <CopyCommand command={install} />
            <a className="flex w-fit items-center gap-2 text-sm text-muted" href={`${latest}/Context-Master-arm64.dmg`}><DownloadSimple size={16} aria-hidden="true" />Or download the DMG for Apple silicon</a>
          </div>
        </div>
        <figure className="rise rise-late m-0 grid gap-4">
          <Image className="screenshot" src="/context-master.webp" width={2400} height={1500} priority unoptimized
            alt="Context Master showing the Tidepool payments specialist answering a question that Claude Code asked over MCP, with numbered citations to saved chats." />
          <figcaption className="text-sm text-muted">Claude Code asked the Tidepool payments specialist about duplicate confirmation emails. The answer comes from two saved chats in the example library.</figcaption>
        </figure>
      </section>

      <section className="page grid gap-10 py-16 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="grid content-start gap-6">
          <h2 className="section-title">Connect an agent</h2>
          <p className="text-muted">Copy the command for your agent from the app’s Connections screen. For Claude Code and a default install it is this one line.</p>
          <CopyCommand command={connect} />
          <p className="text-muted">Then ask from any project. The agent finds the matching specialist and asks it.</p>
          <CopyCommand command={ask} />
        </div>
        <div className="grid content-start gap-6">
          <h2 className="section-title">Tools the agent gets</h2>
          <dl className="facts">
            {tools.map(tool => <div key={tool.name} className="contents"><dt className="font-mono text-sm">{tool.name}</dt><dd>{tool.does}</dd></div>)}
          </dl>
        </div>
      </section>

      <section className="page grid gap-6 py-16">
        <h2 className="section-title">What leaves your Mac</h2>
        <dl className="facts max-w-4xl">
          {privacy.map(item => <div key={item.thing} className="contents"><dt>{item.thing}</dt><dd>{item.where}</dd></div>)}
        </dl>
      </section>
    </main>

    <footer className="page grid gap-2 border-t border-line py-10 text-sm text-muted">
      <p>Runs on Apple silicon Macs. The app is signed locally but not notarized by Apple: the install command avoids the warning, while the DMG needs Open Anyway in System Settings &gt; Privacy &amp; Security.</p>
      <p><a href={repository}>github.com/Imhaohao/context-master</a></p>
    </footer>
  </>;
}
