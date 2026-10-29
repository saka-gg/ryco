# Find in a diff

The Diff panel has a search row above the changed files. It searches file paths and the lines the
diff shows. While a search is active, the panel lists only the files with a match. `Cmd` below is
`Ctrl` on Windows and Linux.

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

## Limits

- Only the lines the diff shows are searched, not the unchanged lines between changes.
- The phone layout of the web app keeps its plain search row, without the options or the find key.
