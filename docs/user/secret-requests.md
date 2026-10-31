# Secret requests

When an agent needs an API key, a token or a password, it does not ask for it in the chat. It asks
on a private card above the composer, and Ryco writes what you type straight into a `.env` file
in the thread's own checkout. The value never enters the conversation, the agent's context, the
thread's history or a log.

## Answering a card

The card says which key the agent wants (for example `STRIPE_SECRET_KEY`), what for, and which
file it goes to (`.env` unless the agent picked another dotenv file). Paste the value and press
**Save**, or **Decline** to say no. The field hides what you type; the eye button shows it.
Spaces and line breaks around the value are trimmed.

Saving writes one line, `STRIPE_SECRET_KEY='…'`, into that file:

- an existing line for the same key is replaced, every other line stays as it was;
- the file is written in one step and readable only by you (mode 0600);
- a multi-line value (a PEM key) is written in double quotes with `\n` for each line break.

The thread shows `STRIPE_SECRET_KEY saved to .env` (or `Declined`), never the value. The agent
learns only that you saved or declined, and loads the key from the environment in its code.

Cards are answered from the desktop and web app, and from the iPhone app. Only the node's owner can
answer: a shared session with another role sees the card read-only.

## What Ryco refuses

Ryco writes only where a secret is safe to keep:

- the file must be inside the thread's checkout, with no links on the way and nothing in `.git`;
- it must be named like a dotenv file: `.env`, `.env.local` (any `.env.*`), `name.env` or
  `.dev.vars`;
- Git must ignore it and must not track it, so a commit can never pick it up. Add the file to
  `.gitignore` first; a folder that is not a Git repository is refused;
- the value must fit in 16 KiB, and a value that mixes quotes, backslashes or `$` with line breaks
  or single quotes is refused, because some loaders would read it back differently.

The agent hears about a bad file when it asks, before any card is shown.

## How long a card waits

A card waits up to 24 hours, also across restarts of the node, and then expires. While it waits,
the thread counts as needing your input: it does not settle, and queued messages and scheduled
wakes wait for it, like an unanswered question.

## What it does not protect

The agent still runs with your account on your node: it could read the file once the key is in
it. Ryco tells agents to load the key from the environment and never to print it, but it cannot
stop an agent that ignores that. Treat a secret you give an agent like one you put in your own
`.env`.
