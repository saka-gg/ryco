# Prompt links

A prompt link opens Ryco with a prompt ready to send. Use one to put a one-click fix in a pull
request comment, in a doc, or in a note to yourself.

A link never runs anything. It opens a draft. You read the prompt, then press Send. A link cannot
change your permission mode or your branch, and it does not create a worktree. Your own defaults
apply. Only a pull request link says where the draft runs, and its checkout happens when you press
Send.

## Make a link

Open the command palette and choose **Copy prompt link**. It copies the draft in the composer, or
the thread's first prompt when the composer is empty. When the project is on GitHub, **Copy prompt
link with repo and model** also adds the repository and the model you picked.

In a browser the link uses the address you are on (your Hub or your machine). From the desktop app
it uses the hosted app's address.

You can also write a link by hand:

```
https://app.ryco.space/new?prompt=Explain%20this%20repository
https://app.ryco.space/new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
https://app.ryco.space/new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

| Parameter  | Meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `prompt`   | The prompt. Required, except on pull request links. At most 8,000 characters. |
| `repo`     | A GitHub repository, as `owner/name` or its URL.                              |
| `provider` | A provider such as `codex` or `claude`, or the id of one of your instances.   |
| `model`    | A model of that provider, by its id or its name. Only read with a `provider`. |
| `pr`       | A GitHub pull request, as `owner/name/123`, `owner/name#123` or its URL.      |

Encode the prompt for a URL. In JavaScript, use `encodeURIComponent`.

## Open a link

The link waits until your machines have sent their projects. On the hosted site it also waits
until the machine you selected is connected again with a fresh session.

- **No `repo`**: the draft opens as a chat without a project, on the machine you used last.
- **`repo`**: the draft opens in your most recently used project for that repository. A fork
  counts only for its own owner. When you do not have the repository, Ryco says so and offers
  **Start without a project**.
- **`provider` and `model`**: used when you have that provider set up. Otherwise your default model
  is used, and Ryco tells you.
- **`pr`**: puts the prompt in the composer of the thread that works on that pull request, on any
  of your machines. When no thread does, the draft opens in the project, on the pull request's
  checkout when you have one. Otherwise Send checks the pull request out into a new worktree first.
  That runs your project's setup script on the pull request's code, so Ryco says so before you
  send.

If the composer already holds text you typed, Ryco asks before it replaces it.

Ryco removes characters you cannot see, such as zero-width, direction and hidden tag characters,
because they can hide instructions for the agent. When a prompt had them, Ryco warns you that it
may be malicious, and the warning stays until you close it.

## On the phone

The Ryco app opens the same parameters on its New Task sheet, for example
`ryco://tasks/new?prompt=Fix%20the%20build&repo=owner/name`. Without a `repo` the sheet keeps the
project it picked. The phone cannot create a pull request worktree yet: a pull request link starts
in the pull request's checkout when you have one, and in the project's checkout otherwise, and
says so.

The web app's phone layout does not open prompt links; use the Ryco app there.
