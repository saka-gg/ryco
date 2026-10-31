# Secret requests

When an agent needs an API key, a token or a password, it does not ask for it in the chat. It asks
on a private card above the composer, and Ryco writes what you type straight into a `.env` file
in the thread's own checkout. The value never enters the conversation, the thread's history, a
tool result or a log. It is in that file, though, and the agent runs on your node: its code (or
the agent itself) can read the file (see [What it does not protect](#what-it-does-not-protect)).

## Answering a card

The card says which key the agent wants (for example `STRIPE_SECRET_KEY`), what for, and which
file it goes to (`.env` unless the agent picked another dotenv file). Paste the value and press
**Save**, or **Decline** to say no. The field hides what you type; the eye button shows it.
Spaces and line breaks around the value are trimmed.

Saving writes one line, `STRIPE_SECRET_KEY='…'`, into that file:

- an existing line for the same key is replaced, every other line stays as it was;
- the file is written in one step and readable only by you (mode 0600);
- a multi-line value (a PEM key) is written in double quotes with `\n` for each line break;
- it goes only into the checkout the agent asked from: if the thread's worktree was removed or the
  thread moved since, Ryco refuses instead of writing into the project's folder.

The thread shows `STRIPE_SECRET_KEY saved to .env` (or `Declined`), never the value. The agent
learns only that you saved or declined, and loads the key from the environment in its code.

Cards are answered from the desktop and web app, and from the iPhone app. Only the node's owner can
answer: a shared session with another role sees the card read-only.

## What Ryco refuses

Ryco writes only where a secret is safe to keep:

- the file must be inside the thread's checkout, with no links on the way and nothing in `.git`;
- it must be named like a dotenv file: `.env`, `.env.local` (any `.env.*`), `name.env` or
  `.dev.vars`, and not end in a code or config extension (`.env.js`, `.env.json`, `.env.sh`);
- Git must ignore it and must not track a file of that name in any letter case (on macOS
  `prod.env` and a tracked `Prod.env` are one file), so a commit can never pick it up. Add the file
  to `.gitignore` first; a folder that is not a Git repository is refused, and so is a folder of
  another repository inside the checkout (an ignored `vendor/` clone, a submodule);
- the value must fit in 16 KiB and hold no `$` and no backslash: dotenv-expand (which Vite and
  Next.js run) and python-dotenv change those even inside single quotes, so Ryco cannot write
  them so that every loader reads them back as typed. Put such a value into the file yourself,
  escaped for your loader. A value that mixes double quotes or backticks with line breaks or
  single quotes is refused for the same reason.

While Ryco writes, the whole new file briefly sits in a temporary file in the repository's own Git
directory (`.git`), which no commit and no `git add -A` reads. One left behind by a crash is
removed by the next write and after a restart.

The agent hears about a bad file when it asks, before any card is shown.

## How long a card waits

A card waits up to 24 hours, also across restarts of the node, and then expires. While it waits,
the thread counts as needing your input: it does not settle, and queued messages and scheduled
wakes wait for it, like an unanswered question.

The card shows in the desktop and web app and in the iPhone app. An older app, and the web app's
phone layout, show the thread as waiting for you but have no card: there you can neither answer
nor decline, and the thread waits until you open it in one of those apps or the day is up.

## What it does not protect

The agent still runs with your account on your node: it could read the file once the key is in
it. Ryco tells agents to load the key from the environment and never to print it, but it cannot
stop an agent that ignores that. Treat a secret you give an agent like one you put in your own
`.env`.

On a shared node, an operator can open files of the project in Ryco's file viewer, the saved file
included. Only the owner can answer a card, but do not save a secret an operator must not see.

The value travels once, from the card to the node, over the connection your app uses. Through the
Hub relay it is end-to-end encrypted when the channel is (a node's default `compatibility` policy
still accepts channels without end-to-end encryption, for older apps). On a direct address it is
encrypted by HTTPS or Tailscale; on a plain `http://` address on your network it is not. Ryco
does not yet refuse an answer on an unencrypted connection.
