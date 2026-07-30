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
    label: "Start work",
    command: 'ccb send --session worker "Fix the auth race"',
    note: "Open or reuse a named Claude Code session, then send the task.",
  },
  {
    label: "Read the pane",
    command: "ccb inspect --session worker --json",
    note: "Classify the live terminal before Codex chooses its next action.",
  },
  {
    label: "Answer a prompt",
    command: "ccb approve --session worker",
    note: "Pick a matching allow option. Refuse when the menu is ambiguous.",
  },
  {
    label: "Change direction",
    command: 'ccb steer --session worker "Keep the patch scoped"',
    note: "Send a correction while Claude keeps working in the same session.",
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
    title: "Unknown stays unknown",
    body: "Weak pane evidence returns unknown. The bridge does not turn a guess into a terminal action.",
  },
  {
    icon: Radio,
    title: "Prompts before keystrokes",
    body: "Approve and deny inspect the current menu first, then match the option by meaning.",
  },
  {
    icon: RefreshCw,
    title: "No replay after uncertainty",
    body: "If delivery may have started, CCB reports an uncertain result and does not send the command twice.",
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
            Codex mobile to Claude Code on your workstation
          </p>
          <h1>Codex Claude Bridge</h1>
          <p className="hero-summary">
            Tell Codex to use the Claude Code session on your workstation. CCB
            keeps that session named and reachable, so a later message can read
            the pane, answer a prompt, or change direction without starting over.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#install">
              Install CCB
              <ArrowDown size={17} aria-hidden="true" />
            </a>
            <a className="button button-quiet" href={githubUrl} target="_blank" rel="noreferrer">
              <GitFork size={18} aria-hidden="true" />
              Read the source
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
        <span>NO EXTRA API KEY</span>
        <span>NAMED SESSIONS</span>
        <span>WINDOWS + UBUNTU CI</span>
        <span>141 TESTS</span>
        <span>MIT LICENSE</span>
      </div>

      <section className="problem-section">
        <div className="section-label">THE GAP</div>
        <div className="problem-copy">
          <h2>Starting Claude is easy. Returning to the same terminal is the useful part.</h2>
          <p>
            Claude Code keeps working context inside an interactive terminal. A
            fresh shell call loses the thread, and a blind keystroke can answer
            the wrong prompt. CCB gives Codex a named session plus commands that
            read before they act. When the pane is unclear, it returns unknown.
          </p>
        </div>
        <div className="phone-proof" aria-label="Remote coding flow">
          <Smartphone size={22} aria-hidden="true" />
          <div>
            <strong>From Codex mobile</strong>
            <span>&quot;Use Claude in auth-fix. Check why CI failed.&quot;</span>
          </div>
          <ArrowRight size={20} aria-hidden="true" />
          <div>
            <strong>On your workstation</strong>
            <span>Codex resumes auth-fix and reads the same pane.</span>
          </div>
        </div>
      </section>

      <section className="mechanics-section" id="mechanics">
        <div className="mechanics-heading">
          <p className="section-label inverse">WHAT CODEX GETS</p>
          <h2>Codex gets a few commands over the real terminal.</h2>
          <p>
            CCB wraps ccmux and tmux. Claude Code still owns authentication,
            model choice, permissions, and billing.
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
          <p className="section-label">WHY THE BORING PART MATTERS</p>
          <h2>Terminal automation should refuse to guess.</h2>
          <p>
            Two Codex chats can target one session. Pane output can be stale.
            Permission menus can change. CCB handles those cases explicitly and
            documents what has not been tested yet.
          </p>
          <a href={`${githubUrl}/blob/main/docs/RELIABILITY.md`} target="_blank" rel="noreferrer">
            See the test matrix and limits
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
        <div className="install-copy">
          <p className="section-label inverse">FIRST RUN</p>
          <h2>Try it on a session you can throw away.</h2>
          <p>
            CCB is early terminal automation. Install it from this repository,
            add ccmux, and run the doctor before handing it a repo you care
            about. Windows users should apply the ccmux patch once.
          </p>
        </div>
        <div className="install-steps">
          <div className="install-step">
            <span>01 / INSTALL CCB + CCMUX</span>
            <CopyCommand command="npm install -g github:kyooosukedn/codex-claude-bridge claude-code-tmux" />
          </div>
          <div className="install-step">
            <span>02 / CHECK THE MACHINE</span>
            <CopyCommand command="ccb doctor" />
          </div>
          <div className="install-step">
            <span>03 / WINDOWS ONLY</span>
            <CopyCommand command="ccb patch-ccmux-windows" />
          </div>
          <div className="install-step">
            <span>04 / START A DISPOSABLE SESSION</span>
            <CopyCommand command={'ccb send --session demo "Inspect this repo. Do not edit yet."'} />
          </div>
        </div>
        <ul className="install-checks">
          <li><Check size={16} /> Node.js 18 or newer</li>
          <li><Check size={16} /> Claude Code installed and signed in</li>
          <li><Check size={16} /> tmux available on your machine</li>
        </ul>
      </section>

      <footer>
        <div className="brand footer-brand">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>Codex Claude Bridge</span>
        </div>
        <p>Early, supervised terminal automation. MIT licensed.</p>
        <a href={githubUrl} target="_blank" rel="noreferrer">
          <GitFork size={17} aria-hidden="true" />
          Source
        </a>
      </footer>
      </main>
    </>
  );
}
