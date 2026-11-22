# TOMLIN

**Your PCs. Your models. Your AI staff.** A local AI app for Windows: chat models, picture models, AI staff, projects and
your other PCs, in one window. A model loads when you press Connect or when you send work to a hire, a project or a
linked PC that needs it; nothing goes to an AI service in the cloud.

[Download](https://github.com/Matthew4509/Tomlin/releases) · [Source](https://github.com/Matthew4509/Tomlin) · [Report an issue](https://github.com/Matthew4509/Tomlin/issues)

> **BETA: not ready for production.** Screens, features and the way data is stored can change from one version to the next,
> and things will break. Try it on your own PCs and home network, keep your own backups, and do not use it for work or data
> you cannot afford to lose. A stable version is **planned** for around February 2027; that is a plan, not a promise.

## Before you use it

- **Free, not for commercial use.** TOMLIN is under the PolyForm Noncommercial License 1.0.0 (see `LICENSE`). The licence
  permits personal use (research, experiment, testing, study, hobby projects, entertainment, religious observance, with no
  commercial application in mind) and use by a charitable organisation, an educational institution, a public research
  organisation, a public safety or health organisation, an environmental protection organisation or a government
  institution. Any other use, including a business using it, selling it or building it into a paid product, needs the
  copyright holder's permission first. Keep the licence text and the `Required Notice:` line with any copy you pass on.
  It is source-available, not open source.
- **As is, no warranty.** You use it at your own risk. Nobody is responsible for lost data, a PC that is slowed down, or what
  a model writes or draws.
- **Models are not ours.** You download each model yourself, mostly from Hugging Face. Each has its own licence and limits:
  read them on the model's page.
- **Your own PCs, on your own network.** It is made for your own PCs on your home network. A guest pass (below) lets
  someone else's PC use your models for as long as the pass lasts.
- **Windows only.** 64-bit Windows, tested on Windows 11 and Windows 10. The release zip carries its own Node.js.
- **Not signed for Windows.** Windows may warn about a program from the internet the first time ("More info", "Run
  anyway"). The release zips carry TOMLIN's own release signature, and Check for updates refuses a download without it.

## What it does

- **Local chat and picture models.** Find and download GGUF models from Hugging Face, or use the ones you already have
  (LM Studio's folder; Ollama's models are found by themselves). Chat models run on the processor first and the graphics
  chip when there is one: NVIDIA cards through CUDA, and any other graphics chip (AMD, Intel) through Vulkan. Connect and
  Disconnect load and free a model. A speed test for each model on each PC, and a guide to which models fit your memory.
- **AI staff.** Hire people with a name, a look and a role, each on the model and the PC you choose. Roles: Default (a plain
  chat window with no role), Coder, Writer, Project manager, Graphic designer and Artist (the pictures role). A hire's level
  (Junior to Senior) follows the size of its model. Edit staff is one page: who they are, what they work on and where.
  Move a hire to another PC; a model that will not fit that PC's memory is refused, with why.
- **Linked PCs.** Link the other PCs in your home with a setup code (and a PIN, if it has one). Links are encrypted (X25519
  keys, AES-256-GCM) unless both PCs' owners tick that a cluster link may go unencrypted (below). Staff can use the models
  on any linked PC; each PC runs one job at a time, and all the PCs work at once. **The PC's owner stays in charge:** a
  linked PC must have its own app lock PIN, and from its lock screen its owner can send **I need to use the pc** (for 1, 2
  or 4 hours) so it stops taking work. From the main PC you can update a linked PC (**Update it**, or **Fast update** for
  all of them), change its run settings, and turn it off when its owner allows that and you know its PIN. A PC whose
  owner ticked **Let linked PCs pull TOMLIN updates from here** can be pulled from.
- **Cluster and Max mode.** **Cluster** runs one model too big for any one PC across your linked PCs, so it runs at all;
  it is for room, not speed (see the measurements below). **Max mode**, a switch in each chat, borrows a linked PC's
  graphics card for a model that fits one PC, and stops using it for a model once it measured slower than the PC alone.
  The split is either by **layers** (each PC holds a run of the model's layers) or by **experts** (in a mixture-of-experts
  model, the experts are spread over the PCs). Every word crosses the network, so both were nearly always slower than a PC
  that holds the whole model. On the Cluster page, **Encrypted links** can be turned off for a cluster link, which is a little faster; it
  needs a tick on both PCs and is on (encrypted) unless you change it.
- **Network Storage.** Choose which drives on your PCs keep a copy of your models (**Main model storage**) and your
  backups (**Backup storage**).
- **Guest passes.** **Create a guest pass** lets someone else's PC use your models for 1 day, 1 week or with no limit,
  and only the PCs and models the pass names; its chats and staff stay on its own PC. **Connect as a guest** uses a pass
  someone gave you.
- **Projects.** **Lets create a project**: a name, a description and a prompt; it is planned in steps and your staff work
  through them on the PCs that are free. Tick **Run and check it when the steps are done** and it then starts the project,
  opens its pages and forms, runs its tests and tries two rounds of repairs, then stops and says what is still wrong.
- **The Bridge** (built in): your project folders, local copies, audits, backups, prompts and live sites in one place.
  A clean audit is not proof the app is safe, and no claim of "secure" rests on a rule count or a green mark: it covers
  the checks that ran, and the page names what was not read. **Push live** sends a project to your own web host through
  cPanel, FTPS or SFTP, and is off until you turn it on.
- **The office** (a small game). Your staff are drawn as little people in an office: at their desk while they work, in the
  boardroom while they think, resting when idle. The tokens they write buy treats, furniture, gym equipment and an arcade
  machine you can play. It is a game: it changes nothing about how they work.
- **Permissions.** What a chat's model may do by itself. With **Screen tools** it can read and bring forward the windows
  on your list, and, only if you turn that on, click and type in them.
- **Connect Claude.** A prompt to paste into Claude Code so it can manage your PCs; it holds no PIN or code.
- **Also:** an app lock (a PIN), a Day / Night / Auto look (or follow Windows), Windows installer, Start with Windows, an
  icon by the clock, Repair install, and a local API for other programs (below).

## Speed: what we measured

These are **this project's own runs**, on a few used PCs. They are not guarantees. Speed is **tokens a second while writing**
(a token is about three quarters of a word; higher is better).

The PCs:

| Name here | Processor | Memory | Graphics card |
|---|---|---|---|
| Main PC | Core i7-6700K (4 cores, 8 threads) | 48 GB DDR4 | Quadro P2000, 5 GB |
| Small PC | small-form-factor desktop (processor not recorded) | 24 GB DDR3 | Quadro K1200, 4 GB |
| Big PC, stage A (10 to about 15 Nov 2026) | one 6-core Xeon | 64 GB DDR3 | RTX 3060 12 GB, from 10 Nov (the first CPU-only runs came before it) |
| Big PC, stage B (about 16 to 20 Nov) | one 6-core Xeon | 128 GB | RTX 3060 12 GB |
| Big PC, stage C (from 21 Nov) | two 8-core Xeons | 256 GB DDR3 | RTX 3060 12 GB |

**The Big PC changed three times, so compare a bar only with bars from the same stage.** Its RAM for stages A and B
comes from the project's notes, not from a reading by the app, and the change from 64 GB to 128 GB is dated only to about
15 to 16 Nov. A run on one stage says nothing about another.

"app" means TOMLIN's own speed test or a real chat; "llama-bench" is the engine's own benchmark (one short run, not a chat).
The last column is a bar: 20 blocks would be 50 tokens a second, and anything under about 3.75 shows as one block, so read
the number. "Max mode" and "Cluster", "layer split" and "experts split" are explained under What it does.

**LFM2.5-8B-A1B Q4 (4.8 GB)**

| Setup | Date, tool, answers or runs | PCs | tok/s | |
|---|---|---|---:|---|
| Main PC alone | 3 Nov; app; 3 | Main PC | **39.3** | ████████████████ |
| Small PC alone | 3 Nov; app; 3 | Small PC | **19.2** | ████████ |
| Max mode: Main PC + small PC | 3 Nov; app; 3 | Main PC + Small PC | **31** | ████████████ |
| Max mode: Main PC + big PC's RTX 3060 | 12 Nov; app; 3 | Main PC + Big PC stage A | **41.1** | ████████████████ |
| Max mode: three PCs | 12 Nov; app; 3 | Main PC + Big PC stage A + Small PC | **17.2** | ███████ |

**Qwen3.5 / 3.6-35B-A3B Q2 (11 GB)**

| Setup | Date, tool, answers or runs | PCs | tok/s | |
|---|---|---|---:|---|
| Main PC alone (3.6) | 3 Nov; app; 3 | Main PC | **11.5** | █████ |
| Max mode: Main PC + small PC (3.6) | 3 Nov; app; 3 | Main PC + Small PC | **7.1** | ███ |
| Max mode: Main PC + small PC, best split found (3.6) | 3 Nov; app; 3 | Main PC + Small PC | **10.8** | ████ |
| Max mode: Main PC + big PC's RTX 3060 (3.6) | 12 Nov; app; 3 | Main PC + Big PC stage A | **5.9** | ██ |
| Max mode: three PCs (3.6) | 12 Nov; app; 3 | Main PC + Big PC stage A + Small PC | **9.3** | ████ |
| Big PC alone, CPU only (3.5) | 10 Nov; app; 13 | Big PC stage A | **5.80** | ██ |
| Big PC alone, with its RTX 3060 (3.5) | 10 Nov; app; 59 | Big PC stage A | **34.06** | ██████████████ |

**Qwen3-Coder-30B-A3B Q4 (17.7 GB)**

| Setup | Date, tool, answers or runs | PCs | tok/s | |
|---|---|---|---:|---|
| Main PC alone | 17 Nov; app; 4 | Main PC | **9.4** | ████ |
| Max mode (experts split): Main PC + big PC | 17 Nov; app; 5 | Main PC + Big PC stage B | **3.7** | █ |
| Big PC alone | 12 Nov; app; 1 | Big PC stage A | **18.17** | ███████ |
| Big PC alone | 21 Nov; app; 60 | Big PC stage C | **19.36** | ████████ |

**Qwen3-Next-80B-A3B Q3 (33 GB)**

| Setup | Date, tool, answers or runs | PCs | tok/s | |
|---|---|---|---:|---|
| Main PC alone | 3 Nov; app; 3 | Main PC | **10.9** | ████ |
| Max mode: Main PC + small PC | 3 Nov; app; 3 | Main PC + Small PC | **4.6** | ██ |
| Big PC alone, CPU only | 10 Nov; app; 6 | Big PC stage A | **3.39** | █ |
| Big PC alone, with its RTX 3060 | 10 Nov; app; 14 | Big PC stage A | **8.67** | ███ |
| Big PC alone, with its RTX 3060 | 21 Nov; app; 16 | Big PC stage C | **9.61** | ████ |

**Qwen3.8-Flash-Next Q3 (89.5 GB)**

| Setup | Date, tool, answers or runs | PCs | tok/s | |
|---|---|---|---:|---|
| Cluster, layer split | 17 Nov; app; 30 | Main PC + Big PC stage B | **1.9** | █ |
| Cluster, experts split (llama-bench) | 15 Nov; llama-bench; 1 | Main PC + Big PC stage A | **2.45** | █ |
| Cluster, experts split, encrypted link | 22 Nov; app; 8 | Main PC + Big PC stage C | **2.85** | █ |
| Cluster, experts split, link not encrypted | 22 Nov; app; 10 | Main PC + Big PC stage C | **3.36** | █ |
| Cluster, experts split (llama-bench, best) | 22 Nov; llama-bench; 1 | Main PC + Big PC stage C | **4.14** | ██ |
| Big PC alone | 21 Nov; app; 10 | Big PC stage C | **7.20** | ███ |

**DeepSeek-V4-Flash (Q2 90 GiB, Q4 155 GB)**

| Setup | Date, tool, answers or runs | PCs | tok/s | |
|---|---|---|---:|---|
| Q2 cluster, layer split (llama-bench) | 14 Nov; llama-bench; 1 | Main PC + Big PC stage A | **1.16** | █ |
| Q2 cluster, experts split (llama-bench) | 15 Nov; llama-bench; 1 | Main PC + Big PC stage A | **1.84** | █ |
| Q2 cluster, experts split, app (about) | 15 Nov; app | Main PC + Big PC stage A | **1.4** | █ |
| Q4 (bigger file) on the Big PC alone | 21 Nov; app; 3 | Big PC stage C | **2.00** | █ |

**Largest models on the Big PC alone**

| Setup | Date, tool, answers or runs | PCs | tok/s | |
|---|---|---|---:|---|
| Qwen3.5-397B IQ4_XS (190 GB) | 21 Nov; app; 6 | Big PC stage C | **1.90** | █ |
| GLM-5.3 IQ2_M (239 GB) | 21 Nov; app; 1 | Big PC stage C | **0.67** | █ |

**What the chart shows, and what it does not:**

- **A model that fits one PC was slower split across PCs.** Every Max mode result but one, for a model that fits on the Main
  PC, was slower than the Main PC alone (35B: 7.1 against 11.5; 80B: 4.6 against 10.9; 30B coder, experts split: 3.7
  against 9.4). Each word waits on the network.
- **Where Max mode helped, exactly:** the small model (LFM2.5-8B) wrote 41.1 with the Big PC's card lent, against 39.3
  for the Main PC alone on another day: about 5% more, and 39.3 is inside the spread of the three Max mode runs (37.5 to
  41.8), so it is not a clear gain. Lending the 3060 raised **reading** speed (the prompt) about four times on the 35B
  models, 101 to 403 tokens a second, against lending the small PC's card (not against the Main PC alone). The Main PC +
  small PC split (31) beat the small PC alone (19.2) for the small model, but was still slower than the Main PC alone
  (39.3). With the best split found, the 35B reached 10.8 against 11.5 alone: close, not faster.
- **Cluster is for room, not speed.** Qwen3.8-Flash-Next (89.5 GB) did not fit the Main PC or the Big PC at 64 GB
  (stage A), so the cluster was the only way to run it then (1.69 to 2.45 by llama-bench). At 128 GB (stage B) the Big
  PC alone ran it at 1.74 by llama-bench, about the same as the layer split (1.69 by llama-bench at stage A, 1.9 in the
  app at stage B); the experts split (2.45) was faster. The
  best cluster figure after the Big PC's last upgrade is 4.14, but that is `llama-bench` over an unencrypted test link.
  Through the app, on the same two PCs and stage, it is 2.85 with the encrypted link (the app's default) and 3.36 with
  encryption off.
- **Once the Big PC had 256 GB (stage C), the same 89.5 GB model fit on it alone and wrote 7.20, 1.7 to 2.5 times the
  cluster figures from the same stage (4.14 llama-bench, 3.36 and 2.85 in the app).** The earlier cluster results were
  measured before that, and are not a fair comparison with it. DeepSeek-V4-Flash's rows are not comparable with each
  other: the cluster used a 90 GiB file, the Big PC alone a 155 GB file. The smaller file on the Big PC alone at 128 GB
  (stage B) made 1.54 by llama-bench: faster than the cluster's layer split (1.16), slower than its experts split (1.84).
- **Thin results:** DeepSeek Q4 (3 answers), GLM-5.3 (1 answer) and the older Big PC rows with one answer are firm only as
  a rough size. The big models think for minutes before answering, and whether those tokens count is not checked.
- **The measured brake is the network round trip**, about 1.3 ms a layer on the unencrypted test link and 2.8 ms
  encrypted, on a 1 Gb home network.
- **Three PCs** (Big PC at 64 GB, llama-bench or a test run): DeepSeek Q2 by layers made 1.31, a little more than two PCs
  by layers (1.16) but less than two PCs by experts (1.84); a dense 24B model made 8.69 against 12.19 on two PCs, so the
  third, weaker PC slowed it.
- **Not measured:** the cluster with the Big PC's 256 GB and a model that does not fit it; a cluster with three PCs at
  stage C; Max mode at stage C. Max mode checks itself: it records its first load of a model, and if it was slower than the
  PC alone it does not use it again for that model.

The raw rows and notes are kept with the project's working files and are not published here.

## What it has built so far (tested 6 November 2026)

Each goal was a one-paragraph prompt, left to work. One model (Qwen3.6-35B-A3B Q2, 11.4 GB) did the planning and the
coding on the Main PC (about 7 to 9 tokens a second). Each result was tried in a real browser.

| Goal | Time | Continue pressed | Result |
|---|---:|---:|---|
| A Flappy Bird-style game | 28 min | 2 | **Works**: flap, pipes, score, best score kept, restart. The score text is small. |
| A fitness tracker | 64 min | 4 (and one plan edit) | **Works**: logs workouts, totals and a chart, keeps data after a reload. Labels sit beside the wrong boxes on a narrow screen. |
| A blog with an RSS importer (Python) | 59 min | 0 | **Partly**: home page, posts and feed work; the admin login does not. |
| A to-do app | 8 min | 0 | **Did not work** as started: its page could not find its script, and nothing was saved. |

Each step checked its own files but nothing ran the whole app, so faults got through. **Run and check** (2.0.75 and later)
now does that. One run each, so times will vary. A stronger model is the next test.

## What pictures to expect

These are real results, so you know what your PC can do. Each one is the same prompt and the same seed, drawn by TOMLIN on
an ordinary PC with nothing retouched; the files here are only made smaller.

> a tall waterfall pouring over a mossy mountain cliff into a clear green pool, mist in the air, soft morning light, photograph, sharp detail

<table>
<tr><th>Model, and what drew it</th><th>Draft</th><th>Mid</th><th>High</th></tr>
<tr><td><b>Realistic Vision 6 + LCM</b><br>Quadro K1200, a 4 GB graphics card</td><td><img src="public/samples/waterfall-realistic-vision-draft.webp" width="220" alt="Realistic Vision at Draft"><br>384×384, 23 s</td><td><img src="public/samples/waterfall-realistic-vision-mid.webp" width="220" alt="Realistic Vision at Mid"><br>512×512, 84 s</td><td><img src="public/samples/waterfall-realistic-vision-high.webp" width="220" alt="Realistic Vision at High"><br>1280×1280, 3.4 min</td></tr>
<tr><td><b>DreamShaper 8 LCM</b><br>Quadro K1200, a 4 GB graphics card</td><td><img src="public/samples/waterfall-dreamshaper-draft.webp" width="220" alt="DreamShaper at Draft"><br>384×384, 20 s</td><td><img src="public/samples/waterfall-dreamshaper-mid.webp" width="220" alt="DreamShaper at Mid"><br>512×512, 78 s</td><td><img src="public/samples/waterfall-dreamshaper-high.webp" width="220" alt="DreamShaper at High"><br>1280×1280, 3.2 min</td></tr>
<tr><td><b>RealVisXL V5 Lightning</b><br>Core i7-6700K, no graphics card, 32 GB of RAM at the time</td><td><img src="public/samples/waterfall-realvisxl-draft.webp" width="220" alt="RealVisXL at Draft"><br>768×768, 7.7 min</td><td><img src="public/samples/waterfall-realvisxl-mid.webp" width="220" alt="RealVisXL at Mid"><br>1024×1024, 24 min</td><td>On a CPU, High draws the same picture as Mid, without the sharpener</td></tr>
</table>

Times are for one picture. TOMLIN 2.0.69, 2 November 2026.

**What did not work, on that same 4 GB card:**
- **RealVisXL** failed all 7 times, so it is shown above on the CPU instead. Plan on a bigger card or a long wait.
- **Qwen-Image 2.1** did not finish a picture in 3 tries. Its High moved from the card to the CPU, where TOMLIN's own estimate was over 6 hours.
- **The two fast models** drew 17 of 18 Mid pictures. One Realistic Vision picture failed.

**Up close:** High's sharpener is made for drawings, so photographs look slightly painted when you zoom in. RealVisXL's Mid has a fine diagonal weave in leaves and rock at full size.

## Backups: what TOMLIN backs up, and what it does not

TOMLIN backs up its workspace, the projects you pick and its own data to your other PCs, and project zips to a drive you
choose. These are project and application backups, **not a backup of Windows or your PC**. Keep your own backups, and keep
one copy somewhere outside your home: a fire, flood or theft can take every copy in it.

- **Your workspace** (projects made with Lets create a project, and files your staff save) and each project ticked **Copy
  this project to my other PCs**: to your linked PCs every 10 minutes when something changed, as git repositories over
  the encrypted link. The newest 30 versions of each are kept, and fewer when the PC's space for them runs low.
- **Chats, staff and settings:** a restore point, only when you press **Back up to it now**; the newest 3 are kept on each PC.
  Before a new version first uses your data, it zips the `data` folder into `backups` too.
- **Project zips to a drive:** tick projects on the Projects page, then **Run backups**. Each zip is checked after it is
  written; backups are only added, never deleted to make room. To restore, right-click a zip and Extract All.
- **Not backed up:** anything else on your PC, files over 256 MB in a project copied to other PCs, a project's git history in
  the copies on other PCs (the drive zips keep it), and models.
- Backups are not locked on the PC that keeps them: whoever uses that PC can open them.

## Privacy: what leaves your PC

Your chats, projects, staff and models stay on your PCs, and TOMLIN has no account and no subscription. It contacts the
internet only for what you start:

- **Model, runner and tool downloads:** Hugging Face (model lists and files), GitHub (the model runners, each checked by
  SHA-256, and update checks), and Microsoft (the Visual C++ Runtime, only if you say yes).
  A linked PC you send a download to fetches it from Hugging Face itself.
- **Web in a chat** (off unless you press it): the words it searches for go to DuckDuckGo, or to Brave Search with your key,
  or to a SearXNG you run, and the model can open the pages it finds on any site.
- **Site checks:** a site check, and the Bridge's checks of sites you add, read those sites' pages.
- **The Bridge:** **Push live** to your own web host, and its Git version check asks GitHub, if you turn it on.
- **Linked PCs** talk over your own network, encrypted unless you turned that off for a cluster link.

## Ways to get TOMLIN

From [Releases](https://github.com/Matthew4509/Tomlin/releases/latest):

1. **TOMLIN-Setup-&lt;version&gt;.exe** (easiest): one file that holds the release zip. Double-click it.
2. **tomlin-&lt;version&gt;.zip**: unzip it, then double-click **Install TOMLIN.cmd**. Both carry their own Node.js,
   packages and CPU model runners, so nothing else is needed.

From the source on this page (**Code > Download ZIP**, or `git clone`):

3. Install Node.js 22.18 or newer from https://nodejs.org (it comes with npm), unzip the source, then double-click
   **Install TOMLIN.cmd**. The source holds no Node.js, packages or model runners: the installer says which are missing
   and asks before it downloads them (the packages from the npm registry, about 36 MB of CPU model runners from the
   llama.cpp and stable-diffusion.cpp releases on GitHub, each checked by SHA-256). Say No and nothing is downloaded.
   To add them yourself first, run these in the folder:
   ```
   npm install --omit=dev --include=optional
   npm run fetch
   ```
4. Or skip installing: double-click **Start TOMLIN.cmd** (below). Unlike the installer, it downloads the missing packages
   and runners without asking first.

## Install

Unzip, then double-click **Install TOMLIN.cmd**. It asks first and **needs no administrator**, but Windows asks permission
(a UAC prompt) in two optional cases:

- **Microsoft's Visual C++ Runtime.** The model runners need it and a clean Windows lacks it. If it is missing or too old,
  the installer offers to download it from Microsoft (about 19 MB), runs it only when Microsoft signed it, and Windows asks
  once. Say No and it says where to get it later. Without it TOMLIN opens, but no model loads, and Connect says why.
- **A firewall rule**, if this is a worker PC that other PCs will link to. Only PCs on your own network are meant to use it.

It copies TOMLIN to `%LOCALAPPDATA%\Programs\TOMLIN`, builds **TOMLIN.exe** there with the C# compiler that comes with
Windows, adds it to the Start menu (and the desktop if you want), asks about starting with Windows, and lists it in
**Settings > Apps**, where Uninstall removes it (your data stays unless you type DELETE). Its icon by the clock opens TOMLIN
in its own window (Microsoft Edge app mode), starts it again, opens the folder, or quits. Run the installer of a newer zip
to update; it asks first. A PC set up before the TOMLIN name (2.0.47 and earlier) keeps its old names; nothing is moved.

## Start without installing

1. Node.js 22.18 or newer: the zip carries its own (`runtime\node`); otherwise install it from https://nodejs.org.
2. Double-click **Start TOMLIN.cmd**. The first start installs the picture tools and the CPU model runners, if missing. TOMLIN
   opens in its own window (Microsoft Edge app mode, else a browser tab) at http://127.0.0.1:8740.
3. Chat models: put `.gguf` files in `TOMLIN\models\chat` in your user folder. Models you already have for LM Studio can stay
   where they are: write that folder's full path on one line in `TOMLIN\models-folder.txt`.
4. Picture models: open **Models** in the Settings list and download one. Realistic Vision 6 + LCM is the one for a CPU.

Closing the black window stops TOMLIN and every model it loaded.

## Updating (your chats and models stay)

Everything you keep lives in one folder outside the app: `TOMLIN` in your Windows user folder: `data` (chats, staff,
pictures, memory, settings, links to other PCs, the app lock), `models`, `runtime` (downloaded graphics-card runners) and
`backups`. The app folder holds only the program.

To update: **Manage updates** (under Settings; also **Manage PC and updates** in the My PC window) opens **Update this install**, with
**Check for updates** (it asks GitHub) or **Update via zip**; or by hand, unzip the new version into its own folder and
start it. It finds the same `TOMLIN` folder, nothing is lost, and linked PCs stay linked. Before a new version first uses
your data it zips the `data` folder into `backups` (the newest 5 are kept). **Settings**, **Data and lock**, opens
the folder, backs up by hand and puts a backup back. A copy older than the data it finds says so and stops rather than
misread it.

## Troubleshooting

- **A model will not load:** Connect says why. The commonest cause is the Visual C++ Runtime (see Install) or too little free
  memory: the Models page shows what each model needs.
- **Windows warns the installer is unsigned:** "More info", then "Run anyway". It is not signed.
- **A linked PC will not answer:** check it is on, on the same network, and has the firewall rule (Network, "Can other PCs
  reach this one?" shows the check). A runner build that differs between PCs stops Max mode and the cluster; Network names
  the PC.
- **Slow:** see the speed section above; a model much bigger than your memory runs, but slowly.

## For other programs

The app and this API listen on 127.0.0.1:8740 only. A PC with linking turned on also listens on port 8741 on your network,
for linked PCs only (encrypted, behind its setup code).

| Endpoint | What it does |
|---|---|
| `GET /api/status` | Hardware, both panes (state, model, device, memory), the current picture job |
| `GET /api/models` | Chat and picture models, whether each fits, the model runners |
| `POST /api/models/{id}/load` | Body `{ "device": "auto" \| "gpu" \| "cpu", "threads": 0 }`; the id is URL-encoded |
| `POST /api/models/{id}/unload` | Ends that model's process |
| `POST /v1/chat/completions` | OpenAI-style chat with the connected chat model (streaming works) |
| `POST /v1/images/generations` | OpenAI-style: `{ "prompt", "n", "size": "600x600", "response_format": "b64_json" \| "url" }` |
| `GET /v1/models` | The loaded models |

The API loads nothing by itself: with no model connected, the chat and picture endpoints answer 409 and say so, and
`GET /v1/models` gives an empty list.
With the app lock on, the `/v1` endpoints answer 423 while it is locked; they work while the app is open in a browser, and
the `/api` endpoints need that browser's own unlock.

## Tests

`npm test`. `test/filter.test.ts` is a release blocker: picture prompts that sexualise anyone under 18, or real people, are
refused.
