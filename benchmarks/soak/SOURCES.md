# Sources

Pages actually opened with WebFetch (20). All prompts are written in my own words; sources gave categories and ideas only.

1. https://minimaxir.com/2025/08/llm-blueberry/ - letter-counting tests (strawberry/blueberry) and why they trip models; basis for the letter-count prompts.
2. https://evalscope.readthedocs.io/en/latest/benchmarks/humaneval.html - HumanEval prompt format (signature plus docstring, code-only reply); basis for "close_pair" style code-small prompt.
3. https://github.com/minimaxir/big-list-of-naughty-strings - repo overview; zero-width space example.
4. https://raw.githubusercontent.com/minimaxir/big-list-of-naughty-strings/master/blns.txt - category headings (emoji, RTL, zalgo, trick unicode, fonts, full-width, special characters) used for the unicode-edge set.
5. https://www.promptlayer.com/glossary/needle-in-a-haystack - how needle-in-a-haystack tests are built (filler, inserted fact, depth, question); basis for long-input needle prompts.
6. https://qawerk.com/blog/prompt-injection-testing-pre-launch-checklist/ - categories of prompt-injection tests (override, persona, encoded, indirect, multi-turn); used only for harmless web-trigger and multi-turn ideas, no attack text copied.
7. https://builtin.com/articles/programming-project-ideas - beginner/intermediate project ideas (calculator, to-do, tic-tac-toe with AI).
8. https://github.com/florinpop17/app-ideas - tiered project list (stopwatch, unit/currency converters, markdown previewer, CSV tools, to-do, quiz/memory games).
9. https://github.com/google-research/google-research/tree/master/instruction_following_eval - IFEval overview (page itself had no instruction list).
10. https://raw.githubusercontent.com/google-research/google-research/master/instruction_following_eval/instructions.py - the kinds of checkable constraints (word/sentence counts, bullets, JSON, case, keywords, postscript, title in angle brackets, separators); basis for instruction-following and formatting sets.
11. https://huggingface.co/datasets/Muennighoff/mbpp - MBPP style (one-sentence "write a function" task plus assert tests); basis for digit_sum style prompts.
12. https://github.com/paul-rottger/xstest - over-refusal test idea (safe prompts that look alarming).
13. https://raw.githubusercontent.com/paul-rottger/xstest/main/xstest_prompts.csv - safe-prompt types (homonyms, figurative language, safe targets, safe contexts, definitions, history); basis for refusal-boundary prompts.
14. https://livecodebench.github.io/ - LiveCodeBench task kinds (generation, self-repair, output prediction, execution); basis for code-debug and predict-the-output prompts.
15. https://mer.vin/2024/09/llm-test-questions/ - community test-question categories (riddles, math word problems, formatting limits, small coding tasks, games).
16. https://github.com/cpldcpu/MisguidedAttention - idea of slightly altered classic puzzles that expose memorised answers; basis for reasoning-trick prompts (single-item river crossing, impossible jug, no-op Monty Hall).
17. https://github.com/openai/grade-school-math - GSM8K word-problem style; math prompts are original problems in that style.
18. https://github.com/google-research/url-nlp/tree/main/mgsm - MGSM languages; basis for the Japanese math prompt.
19. https://en.wikipedia.org/wiki/Zero-width_space - zero-width and related invisible characters (U+200B/C/D, U+2060, U+FEFF).
20. https://en.wikipedia.org/wiki/Bidirectional_text - mixed RTL/LTR behaviour of digits and punctuation; basis for the mixed-direction prompt.

## Search results seen only as snippets (not opened, only for orientation)
Strawberry/cranberry articles (techradar, bagoftricks substack), the OWASP/appsec-labs/repello prompt-injection guides, single-HTML-file game prompt collections (gitea Single-HTML-File-Slop, prompts.chat, techpresso prompt library), and the Real Python 13-projects article. None of their text was used.

## Could not open or verify
- https://peerlist.io/theill/articles/building-ten-simple-games-with-gpt5 - HTTP 403.
- https://realpython.com/python-projects/ - HTTP 403 (project ideas such as URL shortener come only from a search snippet).
- https://en.wikipedia.org/wiki/Least_recently_used_(cache) - HTTP 404; LRU cache and bank-account projects come from general knowledge, not a fetched source.
- No canonical "LLM sanity-check list" page was found; the reasoning-trick set blends the sources above with common community examples (strawberry, 9.11 vs 9.9, kilogram comparison, bat and ball), which I know from search snippets only.
- The expect rules are my own wording and have not been run against any model; some (for example "says it is not aware") need a human or a judge model, not a plain string check.

## Format notes
- `prompt` is a string for most entries; an array of strings (3 to 6 user turns) for multi-turn.
- For long-input and two unicode-edge entries, `prompt` is `{"parts": [ "literal text" | {"repeat":"text","times":N}, ... ]}`; concatenate the parts in order to build the real message.
- Non-ASCII text (emoji, Arabic, Hebrew, zero-width and combining characters) is stored as real characters in the JSON (UTF-8); read the file as UTF-8.
- projects.json: every `prompt` ends with the same output-format paragraph: one fenced block per file, opening fence line `<language> title=<file name>`.
