import {
  ArrowDown,
  ArrowRight,
  Check,
  CircleDot,
  GitFork,
  LockKeyhole,
  Radio,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  TerminalSquare,
} from "lucide-react";
import { CopyCommand } from "./components/CopyCommand";

const githubUrl = "https://github.com/kyooosukedn/codex-claude-bridge";

const commands = [
  {
    label: "Send",
    command: 'ccb send --session worker "Fix the auth race"',
    note: "Start work in a named, persistent Claude Code session.",
  },
  {
    label: "Steer",
    command: 'ccb steer --session worker "Keep the patch scoped"',
    note: "Redirect Claude while the original task is still running.",
  },
  {
    label: "Inspect",
    command: "ccb inspect --session worker --json",
    note: "Read the live pane state before Codex decides what to do next.",
  },
];

const guarantees = [
  {
    icon: LockKeyhole,
    title: "One writer per session",
    body: "Send, slash, and steer share a crash-safe local lock. Terminal input cannot interleave.",
  },
  {
    icon: ShieldCheck,
    title: "Fails closed",
    body: "A lock is recovered only when its owner process is proven dead. Age alone never steals it.",
  },
  {
    icon: Radio,
    title: "Steer stays live",
    body: "The lock ends after injection. Claude can keep working while Codex sends a correction.",
  },
  {
    icon: RefreshCw,
    title: "No blind retries",
    body: "Once transport may have started, the bridge reports uncertainty and leaves the retry decision to you.",
  },
];

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <main id="main-content">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Codex Claude Bridge home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span>CCB</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#mechanics">How it works</a>
          <a href="#reliability">Reliability</a>
          <a href="#install">Install</a>
        </nav>
        <a className="header-link" href={githubUrl} target="_blank" rel="noreferrer">
          <GitFork size={17} aria-hidden="true" />
          GitHub
        </a>
      </header>

      <section className="hero" id="top">
        <div className="relay-scene" aria-hidden="true">
          <div className="relay-grid" />
          <div className="relay-line relay-line-a" />
          <div className="relay-line relay-line-b" />
          <div className="relay-packet packet-a">SEND</div>
          <div className="relay-packet packet-b">STEER</div>
          <div className="scene-node scene-codex">
            <span>01</span>
            <strong>CODEX</strong>
            <small>mobile / desktop</small>
          </div>
          <div className="scene-node scene-lock">
            <LockKeyhole size={19} />
            <strong>SESSION LOCK</strong>
            <small>owner verified</small>
          </div>
          <div className="scene-node scene-claude">
            <span>03</span>
            <strong>CLAUDE CODE</strong>
            <small>persistent tmux pane</small>
          </div>
        </div>

        <div className="hero-copy">
          <p className="kicker">
            <CircleDot size={14} aria-hidden="true" />
            Open source control plane for local agents
          </p>
          <h1>Codex Claude Bridge</h1>
          <p className="hero-summary">
            Drive a persistent Claude Code session from Codex. Start work from
            your phone, steer it mid-run, inspect what happened, and come back
            without losing the conversation.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={githubUrl} target="_blank" rel="noreferrer">
              <GitFork size={18} aria-hidden="true" />
              View on GitHub
            </a>
            <a className="button button-quiet" href="#mechanics">
              See the relay
              <ArrowDown size={17} aria-hidden="true" />
            </a>
          </div>
        </div>

        <div className="hero-console" aria-label="Example bridge activity">
          <div className="console-meta">
            <span>SESSION / worker</span>
            <span className="live-label"><i /> LIVE</span>
          </div>
          <div className="console-log">
            <p><span className="prompt">$</span> ccb send --session worker &quot;Fix the auth race&quot;</p>
            <p className="console-event"><span>17:25:46</span> injection acknowledged / lock released</p>
            <p><span className="prompt">$</span> ccb steer --session worker &quot;Keep the patch scoped&quot;</p>
            <p className="console-event success"><span>17:26:50</span> steer delivered while Claude is thinking</p>
          </div>
        </div>
      </section>

      <div className="fact-strip" aria-label="Project facts">
        <span>NO CLAUDE SDK</span>
        <span>LOCAL-FIRST</span>
        <span>WINDOWS + LINUX CI</span>
        <span>141 AUTOMATED TESTS</span>
        <span>MIT LICENSE</span>
      </div>

      <section className="problem-section">
        <div className="section-label">WHY IT EXISTS</div>
        <div className="problem-copy">
          <h2>Claude keeps the context. Codex keeps the wheel.</h2>
          <p>
            A one-line shell command can start Claude. It cannot hold a real
            working session, read its state, answer prompts, or change direction
            three minutes later. CCB gives Codex those controls without adding
            another paid API.
          </p>
        </div>
        <div className="phone-proof" aria-label="Remote coding flow">
          <Smartphone size={22} aria-hidden="true" />
          <div>
            <strong>From Codex mobile</strong>
            <span>&quot;Use Claude. Keep the existing session.&quot;</span>
          </div>
          <ArrowRight size={20} aria-hidden="true" />
          <div>
            <strong>On your workstation</strong>
            <span>Same pane, same context, controlled locally.</span>
          </div>
        </div>
      </section>

      <section className="mechanics-section" id="mechanics">
        <div className="mechanics-heading">
          <p className="section-label inverse">THE RELAY</p>
          <h2>Three commands cover the working loop.</h2>
          <p>
            The bridge stays small on purpose. Codex orchestrates. Claude codes.
            tmux keeps the session alive.
          </p>
        </div>

        <div className="command-stack">
          {commands.map((item, index) => (
            <article className="command-row" key={item.label}>
              <div className="command-index">0{index + 1}</div>
              <div className="command-name">{item.label}</div>
              <code>{item.command}</code>
              <p>{item.note}</p>
            </article>
          ))}
        </div>

        <div className="architecture-line" aria-label="System architecture">
          <div><TerminalSquare size={19} /><span>CODEX</span></div>
          <ArrowRight size={18} />
          <div><LockKeyhole size={19} /><span>CCB COORDINATOR</span></div>
          <ArrowRight size={18} />
          <div><Radio size={19} /><span>CCMUX / TMUX</span></div>
          <ArrowRight size={18} />
          <div><span className="claude-glyph">C</span><span>CLAUDE CODE</span></div>
        </div>
      </section>

      <section className="reliability-section" id="reliability">
        <div className="reliability-intro">
          <p className="section-label">BUILT FOR THE BAD TIMING</p>
          <h2>Concurrency rules you can explain.</h2>
          <p>
            No daemon, lease timeout, or hidden retry loop. The failure model is
            written down and covered by cross-process tests.
          </p>
          <a href={`${githubUrl}/blob/main/docs/RELIABILITY.md`} target="_blank" rel="noreferrer">
            Read the reliability notes
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
        <div className="guarantee-grid">
          {guarantees.map(({ icon: Icon, title, body }) => (
            <article className="guarantee" key={title}>
              <Icon size={21} strokeWidth={1.8} aria-hidden="true" />
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="install-section" id="install">
        <div>
          <p className="section-label inverse">RUN IT LOCALLY</p>
          <h2>Keep your Claude subscription. Skip another API bill.</h2>
          <p>
            CCB talks to the Claude Code installation you already use. Install
            the bridge, run the Windows patch when needed, then let Codex drive.
          </p>
        </div>
        <CopyCommand command="npm install -g codex-claude-bridge" />
        <ul className="install-checks">
          <li><Check size={16} /> Node.js 18+</li>
          <li><Check size={16} /> Claude Code</li>
          <li><Check size={16} /> ccmux + tmux</li>
        </ul>
      </section>

      <footer>
        <div className="brand footer-brand">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>Codex Claude Bridge</span>
        </div>
        <p>Built in the open. Designed for one machine, many persistent sessions.</p>
        <a href={githubUrl} target="_blank" rel="noreferrer">
          <GitFork size={17} aria-hidden="true" />
          Source
        </a>
      </footer>
      </main>
    </>
  );
}
