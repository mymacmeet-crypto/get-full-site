# Taking aem.live

This file holds the exact commands for <https://www.aem.live>, what each one
gives you, and the mistakes that cost us time.

The general command list for this project is in [command.md](command.md).

---

## Which command should I use?

There are two ways to take this site. They do different jobs.

| You want | Use | Speed | Size |
|---|---|---|---|
| The **text**, for a RAG index or a corpus | `bin/dataset.js` | 19 seconds | 1.8 MB |
| The **pages**, to read offline later | `bin/archive.js` | about 4 minutes | 77 MB |

If your goal is a dataset for RAG, use the first one. Skip to
[Part 2](#part-2-save-the-pages) only if you need pages that open in a browser
with their styling and images.

---

# Part 1: Get the text

This is the right command for a RAG dataset.

```bash
node bin/dataset.js https://www.aem.live
```

That is the whole thing. It takes about 19 seconds.

## Why it is so much faster

aem.live is built on Adobe Edge Delivery Services. Sites built that way give you
two things for free:

- `https://www.aem.live/query-index.json` lists every published page. It also
  gives the title, the description, and the date the page last changed.
- Adding `.md` to any page URL returns that page as clean Markdown. For example
  `https://www.aem.live/developer/aem-playground.md`.

So there is no need to crawl the site and no need to open a browser. The index
already tells you every page. Each page can be downloaded as plain text.

Here is the same page taken both ways:

| | `bin/archive.js` | `bin/dataset.js` |
|---|---|---|
| Size of one page | about 1,100 KB | 8.8 KB |
| How much of that is text | 0.9% | almost all of it |
| Needs a browser | Yes | No |
| Whole site | about 215 MB | 1.8 MB |

The archived page is mostly fonts, images, and stylesheets stored inside the
file. A RAG index throws all of that away anyway.

**The Markdown is not a cut-down version.** We compared one page both ways. The
Markdown had 126 different words. The archived page had 100. The only words in
the archived page but missing from the Markdown were `home`, `documentation`,
`back`, `mail`, `select`, `link`, and `copied`. Those are menu and button
labels, not content.

## What you get

Everything lands in `archive/www.aem.live/`:

| Folder or file | What is in it |
|---|---|
| `markdown/` | One `.md` file per page. The folders match the site, so `/developer/aem-playground` becomes `markdown/developer/aem-playground.md`. |
| `dataset.jsonl` | One page per line, as JSON. Sorted by path. |
| `dataset-manifest.json` | Totals, counts per section, any failures, and the record of what was taken. The next run reads this. |

The `markdown/` folder holds the same text as `dataset.jsonl`. It is there so you
can open, read, and search the pages without writing any code:

```bash
ls markdown/developer/                       # see the pages
cat markdown/developer/aem-playground.md     # read one
grep -rl "sitemap" markdown/                 # find pages that mention something
```

The folder is rewritten every time you run the command, so it always matches the
dataset. If a page is removed from the site, its file is deleted too. Use
`--no-files` if you only want the JSON.

One line of `dataset.jsonl` looks like this:

```json
{
  "id": "3f2a…",
  "url": "https://www.aem.live/developer/aem-playground",
  "path": "/developer/aem-playground",
  "section": "developer",
  "title": "Explore new AI workflows in AEM",
  "description": "…",
  "lastModified": "2026-08-05T20:21:41.000Z",
  "source": "https://www.aem.live/developer/aem-playground.md",
  "format": "markdown",
  "bytes": 8454,
  "sha256": "…",
  "fetchedAt": "2026-08-24T…",
  "text": "# Explore new AI workflows in AEM\n\n…"
}
```

The last run took **181 pages**, about **1.8 MB** of text:

```
docs               87
developer          68
blog               18
business            4
community           1
developers-live     1
gnav                1
(root)              1
```

**The text is not split into chunks.** That is on purpose. Chunk size depends on
which embedding model you use, so the RAG engine should decide it. This keeps
each page whole.

## Running it again is the update

To get fresh content, run the same command again:

```bash
node bin/dataset.js https://www.aem.live
```

It reads the index first and checks the `lastModified` date of every page. Pages
that have not changed are kept from the file you already have. Only changed
pages are downloaded again.

```
181 document(s) in scope: 3 to fetch, 178 unchanged, 14 skipped
Duration: 1.7s
```

So an update costs 1.7 seconds instead of 19.

Two more things it handles:

- If a page is removed from the site, it is removed from your dataset. Your RAG
  index will not keep answering with a page that no longer exists.
- If a page has no `lastModified` date, it is always downloaded again. Without a
  date there is no proof it is unchanged.

To rebuild everything from scratch, add `--force`.

## Pages the site says not to index

The site index has a `robots` column. The publisher uses it to mark pages that
should not be indexed. Those pages are left out by default.

On aem.live that removes 14 pages, and they are exactly the ones you do not want
in a RAG index:

```
/footer  /new-nav  /new-footer  /side-navigation     menus and page furniture
/thank-you  /business/thank-you  /vip/thank-you      "thanks for your form" pages
/drafts/uncled/helix6                                a draft
/experiments/short-home/home                         an experiment
/developer/integrations  /docs/optel-explorer        marked noindex by Adobe
/business/comms-channel-thank-you  /vip/intake  /vip/customer-chat
```

Add `--include-noindex` if you want them anyway.

## Checking first with `--dry-run`

`--dry-run` tells you what the command would do. It does **not** download the
pages, and it does **not** write `dataset.jsonl` or the `markdown/` folder. That
is the whole point of it: look before you take.

```bash
node bin/dataset.js https://www.aem.live --dry-run
```

```
Would collect:     181
Would fetch:       181
Already have:      0
Skipped:           14 (robots-noindex: 14)
...
Preview:           archive\www.aem.live\dataset-manifest.dry-run.json
Would write:       archive\www.aem.live\dataset.jsonl and archive\www.aem.live\markdown
Run the same command without --dry-run to collect it.
```

It does leave one file behind: `dataset-manifest.dry-run.json`. That file lists
every page it would download, every page it would keep from last time, and every
page it skipped with the reason. So you can check the plan before running it for
real.

The `.dry-run` in the name is deliberate. A dry run can never overwrite the
manifest of a real collection.

**If you want the pages, drop the flag:**

```bash
node bin/dataset.js https://www.aem.live
```

## Useful options

```bash
# check what would be taken, without taking it
node bin/dataset.js https://www.aem.live --dry-run

# one section only
node bin/dataset.js https://www.aem.live --include "^/developer/"

# everything except the blog
node bin/dataset.js https://www.aem.live --exclude "^/blog/"

# download everything again, ignore the dates
node bin/dataset.js https://www.aem.live --force

# save the file somewhere specific
node bin/dataset.js https://www.aem.live --dataset ./corpus/aem.jsonl

# only the JSON, no .md files
node bin/dataset.js https://www.aem.live --no-files

# put the .md files somewhere else
node bin/dataset.js https://www.aem.live --files-dir ./corpus/md
```

The full option list is in
[command.md](command.md#collecting-a-text-corpus).

## One thing to check before you use this

aem.live is Adobe's documentation. Using it as a RAG index for your own tools is
one thing. Using it to train a model is a different question, with different
terms. Read Adobe's terms of use before the dataset grows.

---

# Part 2: Save the pages

Use this only if you need pages that open offline in a browser, with their
styling and images. For a RAG dataset, Part 1 is better in every way.

## The command

```powershell
# PowerShell
node bin/archive.js https://www.aem.live/developer/aem-playground --include "^https://www\.aem\.live/developer/" --depth 10 --max-pages 200
```

```bash
# Git Bash, macOS, Linux. Note the dots are NOT escaped here. See mistake 2.
node bin/archive.js https://www.aem.live/developer/aem-playground --include "^https://www.aem.live/developer/" --depth 10 --max-pages 200
```

`--include` takes a regular expression. It is tested against the full page URL.
Starting it with the `/developer/` part is what keeps the crawl inside that one
section. Everything else on the site, such as `/docs` and `/blog`, is skipped.

## Mistake 1: `/developer` is a 404

There is no page at `https://www.aem.live/developer`. So you cannot use it as
the starting URL:

```
warn fetch failed (HTTP 404) after 1 attempt(s): https://www.aem.live/developer
```

This matters less than it looks. The site has a `sitemap.xml` that lists all 68
`/developer` pages, and the crawler treats every sitemap URL as a starting point
too. So the starting URL is only a way in. Any real page in the section works.
We used `/developer/aem-playground`.

## Mistake 2: do not escape the dots in Git Bash

Git Bash on Windows changes backslashes in arguments before Node sees them. A
`\.` arrives as `/.`:

```
$ node -e 'console.log(process.argv[1])' "^https://www\.aem\.live/developer"
^https://www/.aem/.live/developer          <- not what you typed
```

The pattern then matches nothing. The crawl saves zero pages and shows no error:

```
Pages archived:    0
Skipped:           181 (sitemap-out-of-scope:no-include-match: 181)
```

PowerShell does not do this, so the escaped version is correct there. In Git
Bash, drop the backslashes. An unescaped `.` matches any single character, which
does no harm in a web address.

## Mistake 3: `developer` also matches `developers-live`

`--include "^https://www.aem.live/developer"` also matches
`https://www.aem.live/developers-live`, which is a different page. Adding the
slash at the end, `/developer/`, keeps it out.

## What the run produced

`archive/www.aem.live/`, about 77 MB:

| Folder or file | What is in it |
|---|---|
| `site-data/` | 68 files, one per page, nested to mirror the site's own paths. Each `.html` opens offline with a double-click; `--format md`/`both` puts a `.md` beside it. |
| `assets/` | 3 linked text files. Links inside the saved pages point at them. |
| `report/crawl-report.json` | The full record: totals, every skipped URL and why, and failures. |
| `report/archive-index.json` | Which URL became which file. |
| `report/sitemap.xml` | A sitemap of what was actually saved. |
| `report/assets-inventory.json` | Every file type the section links to, taken or not. |

Summary of the run:

```
Sitemap:           68 URL(s) seeded from 1 file(s)
URLs discovered:   85
Pages archived:    68
Skipped:           377
Failed:            1
```

The one failure was `https://www.aem.live/developer/block-party`. That is the
site's own broken link, not a problem with the crawler. The page does exist, but
only at `/developer/block-party/` with a slash on the end. `bin/dataset.js`
takes it correctly. A `ue-trial-terms.pdf` linked from the section is also a
404.

## Check the scope first

`--dry-run` crawls and reports but saves no pages. On this section it takes
about 45 seconds:

```bash
node bin/archive.js https://www.aem.live/developer/aem-playground --include "^https://www.aem.live/developer/" --depth 10 --max-pages 200 --dry-run
```

Look at the `Skipped:` line. A big `no-include-match` count together with
`Pages archived: 0` means your pattern is wrong. That is how mistake 2 was
found.

A dry run writes its report to `report/crawl-report.dry-run.json` and
`report/assets-inventory.dry-run.json`. It uses different names on purpose, so
it can never overwrite the report of a real crawl.

## Other things you can do

**Take the videos too.** The section links 8 `mp4` files and an `svg`. The
default setting skips them:

```powershell
node bin/archive.js https://www.aem.live/developer/aem-playground --include "^https://www\.aem\.live/developer/" --depth 10 --max-pages 200 --assets documents,media --overwrite
```

**The docs section instead**, 87 pages:

```powershell
node bin/archive.js https://www.aem.live/docs/ --include "^https://www\.aem\.live/docs/" --depth 10 --max-pages 200
```

**The whole site**, no filter:

```powershell
node bin/archive.js https://www.aem.live/ --depth 10 --max-pages 500
```

**Just see what file types are there.** This reads each page once for its links,
saves nothing, and writes only `report/assets-inventory.survey.json`:

```powershell
node bin/archive.js https://www.aem.live/ --survey
```

## Running it again

Files already in `site-data/` and `assets/` are not overwritten unless you add
`--overwrite`. So a second run skips what is already saved. Two things to watch:

- **Files from older crawls stay where they are.** They will not appear in
  `archive-index.json`, because that file only describes the most recent run. If
  you need the folder to hold one section and nothing else, archive into an
  empty folder or delete the extra files first.
- **`--resume` matches the starting URL exactly.** To continue this crawl you
  must pass `https://www.aem.live/developer/aem-playground` again, character for
  character. One character different and the crawler starts over.

---

## Notes

`archive/` is in `.gitignore`, so nothing it holds is committed to the
repository. The folder is currently empty. Either command above rebuilds its own
output, and `bin/dataset.js` takes about 20 seconds to do it.
