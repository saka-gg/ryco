# Find in a diff

You can find text in two diffs: the Diff panel beside a thread, and the **Files** tab of a pull
request. `Cmd` below is `Ctrl` on Windows and Linux.

The Diff panel has a search row above the changed files. It searches file paths and the lines the
diff shows. While a search is active, the panel lists only the files with a match.

## Open it with the find key

Click anywhere in the Diff panel, for example on a line of the diff, then press `Cmd+F` to put
the cursor in the search row. If you selected text on one line of the diff first, it becomes the
search. Pressing `Cmd+F` again in the search row selects what you typed.

The key is your **Find in current thread** shortcut (**Settings > Keybindings**). Outside the Diff
panel it still finds in the thread.

## Move between matches

- `Enter` goes to the match the counter shows, then to the next one. `Shift+Enter` goes back.
- A match in a folded file opens the file. Find never folds a file again.
- The current match is highlighted more strongly than the others.
- `Escape` clears the search and leaves focus in the diff, so arrow and page keys keep scrolling it
  and `Cmd+F` finds again.

## Options

The three buttons next to the search field change how it matches:

- **Match case**: upper and lower case must match.
- **Match whole word**: letters, digits and `_` make up words, as in `git grep -w`. `name` then
  finds `a.name()` but not `names` or `my_name`.
- **Use regular expression**: the search is a JavaScript regular expression. A pattern that does
  not compile shows **Invalid pattern**, and the panel keeps every file. A pattern that takes too
  long stops after a tenth of a second with the matches found so far and shows
  **Search stopped (pattern too slow)**; the files it did not reach stay in the list. With this option on, a selection that seeds the search is
  escaped, so it still matches literally.

The search is not trimmed: leading spaces find indentation. It stops at 100,000 matches; the
counter then ends in `+` and the files it did not reach stay in the list. The options last while
the panel is open and are off again the next time you open it.

## A pull request's files

In the **Files** tab of a pull request, on the pull requests page or beside a thread, click into
the diff or the file tree and press `Cmd+F`. A find bar opens above the diff with the same field,
options and counter.

- It searches the lines of every file, also files you marked **Viewed** and files that start
  folded (generated files, very large changes). The file tree's **Filter files** field finds paths.
- The diff is not filtered: every file stays where it is.
- A new search starts at the first match from where you are reading, not at the top of the pull
  request. `Enter` goes there.
- A match in a folded file opens that file. Its **Viewed** mark stays.
- `Escape` in the field, or the close button, closes the bar and leaves focus in the diff, so the
  page's keys (`J`, `K`, `V` and the others) keep working.
- The options last while the pull request is open. A new push keeps the current match when its
  line is still there; choosing a single commit closes the bar.

The pull requests page's shortcut list (`?`) shows your find key under **Review**.

## Limits

- Only the lines the diff shows are searched, not the unchanged lines between changes.
- The phone layout of the web app keeps its plain search row, without the options or the find key.
