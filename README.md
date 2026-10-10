# TOMLIN 2.0

> **BETA: not ready for production.** TOMLIN is still in beta. Features, screens and the way it stores your data can
> change from one version to the next, and things will break. Try it on your own PCs and home network, keep your own
> backups, and do not use it for production work or for data you cannot afford to lose.

Chat and pictures on your own PC: two panes, side by side. Each one loads a model only when you press **Connect**,
and **Disconnect** ends that model's process and gives its memory back. You can run chat only, pictures only, both,
or neither. Everything runs on your own PCs (this one, and any you link on your home network). Nothing goes to an
outside service except what you start yourself: model and tool downloads, the Bridge's checks of sites you add, and
Push live (off until you turn it on), which sends a project to your own web host.

## Before you use it

- **Beta.** Screens, features and the way data is stored still change between versions, and things will break.
- **Free, not for commercial use.** TOMLIN is under the PolyForm Noncommercial licence 1.0.0 (see `LICENSE`). Free for
  personal use, hobby projects, study, charities, schools, public research and government. A business using it,
  selling it or building it into a paid product needs the copyright holder's permission first.
- **As is, no warranty.** You use it at your own risk.
  Nobody is responsible for lost data, a PC that is slowed down, or what a model writes or draws.
- **Your own PCs only.** It is made for your own PCs on your own home network. Keep your own backups.
- **Models are not ours.** You download each model yourself; each has its own licence and its own limits. Check them.
- **Windows.** Made for 64-bit Windows (tested on Windows 11). The zip carries its own Node.js.

## What it does

**Chat and pictures on your own PC**
- Chat models and picture models run on this PC: the processor first, the graphics chip when there is one.
- A model loads only when you press **Connect**; **Disconnect** gives its memory back.
- Speed test for each model on each PC (first word, tokens a second), and a guide to which models fit your memory.
- Chats grouped by project; **Recent chats** and **pinned chats** in the left panel; rename a chat in place.
- Copy, Pin and **Send to** under each answer (hand an answer to someone else on the team, as a prompt or a brief).
- Scratch pad, Snippets (prompts to use again), documents added to a chat, a memory line per person.

**Staff you hire**
- Hire people with a name, a role (Default, Coder, Writer, Project manager, Graphic designer, Artist), a level and a
  look; each works on the model you choose for them, on the PC you choose.
- Move a hire to another PC; a model that will not fit that PC's memory is not offered (and refused if sent), with why.
- Staff overview: who is reading, thinking, typing or drawing, and on which PC.

**Linked PCs (nodes)**
- Link the other PCs in your home: find them on the network, then type the PC's **setup code** and, if it has one,
  its **PIN**. The link is encrypted (X25519 keys, AES-256-GCM); the code and PIN are never sent.
- Staff can use the models on any linked PC; the queue runs one job on each PC at the same time.
- **The PC's owner stays in charge.** A linked PC must have its own app lock PIN. Its owner can press **"I need to
  use the pc"** to stop taking work, or send the main PC a message from the lock screen (**please log out for 1, 2
  or 4 hours**); the main PC sends the work elsewhere.
- **Backups only**: a PC that keeps backups and takes no other work. Project backups go to linked PCs as real git
  repositories over the link, with no internet needed.
- **Update it**: update a linked PC from the main PC. A build id shows when a PC has different files even at the same
  version.

**Projects**
- **Lets create a project**: a name, a description and a prompt; it is planned in steps and your staff work through
  them, on the PCs that are free. A queue for chats, pictures and project steps.
- **The Bridge**: your project folders, local copies, audits, backups and prompts in one place.
- **Push live**: send a project to your web host in one press (cPanel, FTPS or SFTP); its address becomes the
  project's live address in the Bridge. Secrets (passwords, keys) stay locked by Windows on this PC and go to one file
  outside the site's web folder; a file with a key or a private detail stops the push; **Go back** puts back the
  files of the last push (not the secrets or a database); on cPanel it also makes the MySQL database and loads a
  .sql file. Off until you turn it on.
- **Connect Claude**: a prompt that lets Claude act as the project manager of your PCs (it holds no PIN or code).

**Looking after it**
- **App lock**: a PIN for the whole app (4 to 12 digits), optional on the main PC.
- Each PC's uptime, tokens written and what the work would have cost on paid AI services.
- Mute, notifications, a Day / Night look.
- Windows installer (no administrator needed), Start with Windows, an icon by the clock, **Repair install**.

**The office (a small game)**
- Your staff drawn as little people in an office: at their desk while they work, in the boardroom while they think,
  in the kitchen or the lounge while they rest, at the beach when their PC is off. The boardroom and the lounge start
  empty: the tokens your staff write buy the furniture piece by piece, and deck chairs on the beach for their breaks.
- Rewards paid from the tokens your staff have written: **coffee** (delivered to each of them), **donuts**, and
  **gym equipment** (500,000 tokens, kept). Free pizza, employee of the month, and a weekly leaderboard.

## Install (2.0.37)

Unzip, then double-click **Install TOMLIN.cmd**. It asks first, needs no administrator and downloads nothing
(the zip carries its own Node.js), with one exception: the model runners need Microsoft's **Visual C++ Runtime**, which
a clean Windows does not have (most PCs got it from another program). When it is missing or too old (2.0.43), the
installer offers to download it from Microsoft (about 19 MB), runs it only when Microsoft signed it, and Windows asks
for permission once; say No and it says where to get it later. Without it TOMLIN opens, but no model loads, and
Connect says why. It copies TOMLIN to `%LOCALAPPDATA%\Programs\TOMLIN`, builds
**TOMLIN.exe** there with the C# compiler that comes with Windows (so there is no installer to sign), adds it to
the Start menu (and the desktop if you want), asks about starting with Windows and (for a PC other PCs link to) the
firewall rule, and lists it in **Settings > Apps**, where Uninstall removes it again (your data stays unless you type
DELETE). TOMLIN.exe runs it with no console window: its icon by the clock opens TOMLIN in its own window
(Microsoft Edge app mode), starts it again, opens the folder, or quits. Run the installer of a newer zip to update; it
asks first. From then on a linked PC can be updated from the main PC (Update it on its tile), and the shortcuts keep
working because they all point at TOMLIN.exe, which reads `current.txt` to know which copy to run. The folder
keeps the copy in use and the one before it. A PC set up before the TOMLIN name (2.0.47 and earlier) keeps its names:
`Programs\Smart Manager`, **Smart Manager.exe**, its Settings > Apps entry and the `Smart Manager` data folder in the
user folder; nothing is moved under it, and updates and Repair install keep using them (a new PC gets TOMLIN for
all). Windows may warn about a program from the internet the first time ("More info", "Run anyway"): the installer
is not signed.

## Start without installing

1. Node.js 22.18 or newer: the zip carries its own (`runtime\node`); otherwise install it from https://nodejs.org.
2. Double-click **Start TOMLIN.cmd**. The first start installs the picture tools and the CPU model runners, if they
   are missing. TOMLIN opens in its own window (Microsoft Edge app mode, else a browser tab) at
   http://127.0.0.1:8740.
3. Chat models: put `.gguf` files in `TOMLIN\models\chat` in your user folder (for example
   `C:\Users\you\TOMLIN\models\chat`). Models you already have for LM Studio can stay where they are: write that
   folder's full path on one line in `TOMLIN\models-folder.txt`. Ollama's models are found by themselves.
4. Picture models: press **Models** in the top bar and download one. Realistic Vision 6 + LCM is the one for a CPU.

Closing the black window stops TOMLIN and every model it loaded.

## Updating (your chats and models stay)

Everything you keep lives in one folder outside the app: `TOMLIN` in your Windows user folder. In it, `data`
(chats, staff, pictures, memory, settings, links to other PCs, the app lock), `models` (downloaded models),
`runtime` (downloaded graphics-card runners) and `backups`. The app folder holds only the program.

To update: unzip the new version into its own folder and start it. It finds the same `TOMLIN` folder, so
nothing is lost and nothing is downloaded again, and PCs linked to it stay linked. Before a new version first uses your
data it zips the `data` folder into `backups` (the last 5 are kept; models are not in them). **Settings** (top bar),
**Your data and updates**, opens the folder, backs up by hand and puts a backup back.

Coming from a version that kept everything inside its own folder (2.0.25 and older): the first start finds that folder
beside the new one (or the same folder) and asks **Import your chats?** It copies the data (the old folder keeps its
own) and moves the models and graphics-card runners (no download). TOMLIN starts again to do it. **Start
empty** begins with nothing. A copy older than the data it finds (data changed by a newer version) says so and stops
rather than misread it.

## The page

- **Hire staff and the PC window, new layout (2.0.44, from the Codex designs of 8 Oct):**
  - **Hire staff** is one window, opened from Home's role icons, HIRE STAFF in the left panel, the Staff window's
    **Hire staff** button, "Hire one" in a project, and a PC window's **Hire staff on this PC**. Left: their look (the
    round picture; **Change look** opens the look editor under it), **Name** (from the model unless typed; Random),
    **Role** (all six), **Level** and what they will run on. Right: **Assign a PC** (this PC and each linked PC as a
    card: on, off or away, its RAM and graphics memory, how many models of the role's kind it has or shares), then
    **Choose a model** on that PC: search, cards with the memory each needs (a chat model at an 8K context), its file,
    the size level, Loaded / Installed / Loads when asked, and a warning when it needs more memory than is free (never
    a block: any model can be picked). **Show hidden** shows there when the PC has a hidden model. The level starts at
    the size of the model picked (Junior, Experienced, Expert, Senior; a picture model by its size on disk) and can be
    changed; changed by hand, it stays. No model on this PC: hire now and pick it after (their profile opens).
    The Staff window no longer has its own Hire new side: the right side is always Edit Staff.
  - **The PC window** (this PC and each linked PC): left, its photo, Name and Make / model, and **Specifications**
    (this PC: processor, RAM, graphics memory, disk free on the drive TOMLIN keeps its data on; a linked PC: its
    memory as it last said). Right: a strip (TOMLIN version, tokens processed, time worked, estimated power
    cost), then its models: **Installed models** here, **Models it lets this PC use** for a linked PC, with search,
    **All | Chat | Pictures | Hidden**, **Sort** (name, size, in use first) and pages of 10. On this PC each has Test
    speed, Hide / Unhide and Delete (the bin; it asks first, and says why when the model is loaded, hidden or kept by
    Ollama). Then **Staff using this PC** (time each worked in the last 7 days) and **Most-used models** (last 7 days),
    and folded away **Power costs & settings** (power, cost per project, price per million tokens, the prices). This
    PC's Repair install, Shortcut to desktop and Start on start up are under **Manage PC** at the top.
  - **New counts:** time worked per hire per day (usage-staff.json, `worked`), and per PC and model the time worked
    and answers per day (usage-models.json, 30 days). Both start from this version, so they are empty at first.

- **PC name, make / model and photo (2.0.44):** press a PC in the left panel: under its top line, a photo (Add a
  photo / Change photo / Remove photo; PNG, JPEG, WebP or GIF up to 15 MB, kept as a 512 px square, turned the right
  way up) and **Name** ("Study laptop") and **Make / model** ("Dell OptiPlex 9020"). The left panel, the PC window and
  each hire's PC then use that name ("Study laptop", "16 GB / 0 VRAM · Dell Latitude 7490"); with no name, the make /
  model; with neither, the name it gives itself. Kept on this PC only (data/pc-profiles/); a linked PC's own name is
  never changed. Memory now reads "32 GB / 4 GB VRAM" and "16 GB / 0 VRAM".
- **Staff look (2.0.44):** Hire staff (Change look) and Edit Staff have a **Look** part: gender, skin, hair, hair colour, top,
  glasses, facial hair, headwear (lists in src/look.ts, drawings in public/look.js), with the round picture and the
  person seen from above turning round as you pick. Saved per hire in staff.json (`look`); every pick saves. It is the
  hire's round picture wherever they have no profile photo (a photo still wins: "Take the photo off" is beside it), and
  the office in Staff overview draws the same person. A hire with no saved look keeps initials; the editor shows a made-up look
  (the same one each time) until a part is picked or **Use this look** is pressed. **Show initials instead** forgets it.
- **The office (Staff overview, 2.0.44):** a tile at the top of Staff overview (Home's right panel and the chat's), drawn
  by public/office.js from Home's staff list. Desks = My PC and each linked PC. What each hire does comes from the server
  (src/home.ts doingOf): Researching (their model reads what it was sent), Thinking, Typing, Drawing, Working on a
  project, Waiting for the PC (another answer is on it), Getting ready (model loading), Resting, Away (the PC's
  owner uses it: the lounge, a nap, or helping a brainstorm), PC off (out of the front door to a towel on the beach; the PC in the far corner in cobwebs). All work
  is done at the desk (a think over 15 s goes to the boardroom once it has a table); idle: 2 min at the desk, then stretching in the room,
  after 5 min the kitchen or lounge, after 10 min a deck chair on the beach if one is bought and free (`idleFor` from the server, which remembers each hire's last answer). Press a person or their card to follow them; a chat
  follows the person talked to. **Watch** = full screen, Esc closes. Drag a person onto a desk (in the office, or from the
  left panel) = the Move window; they then carry a box to the new desk. Frames only while it is on screen.
  Fire (Staff) = app.office.fire: full view zoomed on them, the boss walks in, a box is packed, out of the front
  door. Full view: **Award employee of the month** (POST /api/office/award: most tokens written this month, from
  meter.ts ByStaff `written` per day; kept in data/office.json; portrait on the lounge wall; a 20% off voucher shown in
  "Holding"; **Undo award** takes this month's back, POST /api/office/award/undo, and the leaderboard says when someone has written more since; a tie is not awarded), **Buy them pizza** (page only), this week's leaderboard (GET /api/office, from Monday). **The shop**
  (**Look after the team**, a menu of picture cards beside the office, under it on a phone: Treat the team, then
  Improve the office by room; each card its price, what is bought, and how far off it is): the team's tokens written are its money ("To spend": every token every hire ever wrote,
  less what was spent; ByStaff totalWritten, src/home.ts purseOf). **Coffee** (10,000): a coffee delivery comes in
  by the front door with a tray and hands each of them a cup wherever they are, busy or not (not the staff of a PC
  that is off). **Donuts** (25,000): a donut delivery to the kitchen table, like the pizza. **Furniture
  (2.0.50):** the boardroom and the lounge start EMPTY in every office (one made before included: nothing counts
  as owned, nothing refunded) and each piece is bought once: boardroom table 75,000 (opens the room: a long think goes to
  it; without it the think stays at the desk), chairs 25,000 a pair up to six (after the table; the thinkers sit first,
  each chair left over seats a helper, up to two), whiteboard 40,000 (notes while someone thinks there); lounge armchair
  30,000 (nap), bookcase 50,000 (reading), sofa 60,000 (chatting), TV 75,000 (watching), gym equipment 500,000 (treadmill
  and weights); an empty lounge sends the idle to the kitchen and away staff (owner using their PC) to its window.
  **Deck chair and umbrella** 50,000 each, up to six: a hire resting 10 minutes at a desk of their own takes a break in a
  free one (On a break: sitting up, a drink, a green cup mark) and walks back when work comes (the work never waits);
  the staff of a PC that is off lie on towels (PC off: sunglasses, a grey power mark); Staff overview's card says which.
  POST /api/office/buy {item} (src/home.ts buy: refuses an unknown item, one bought already, chairs before the table, or
  more than the purse holds, and says why); GET /api/office sends `rooms` (src/home.ts roomsOf: what each room offers);
  purchases kept in data/office.json beside the awards (every kept piece for good, the last 1000 treats).
  Also: IT carries a newly linked PC in (and a removed one out) while watched; a project step starting brings a folder
  by courier (it stays on the desk until the step ends); up to two idle people (away, no desk, or idle 2 min+) help a
  think that has gone on 15 s in the boardroom, one to each chair left over; Away = lounge, a nap, or the brainstorm. app.office.advance(s) steps
  the office for checks (the browser pane can stop giving frames).
- **Projects (the Bridge, 2.0.44):** left panel, under Home. Myia Bridge, built in, in its own look (Orbital,
  Windows, Light, Dark): every project folder in your working folders, local copies started and stopped (from each
  project's `.claude/launch.json` or `project.json`), the built-in audit (about 130 rules, the privacy pass, Not a
  fault, Review with AI), git marks and See what changed, Hosted live lights, prompts, and the tokens your AI tools
  used. Its page is `/bridge/`, its code `src/bridge/` (plain JavaScript) and `public/bridge/`, its data the home's
  `data/bridge`. TOMLIN's app lock covers it; its page's own Help says what each part does. Added in Smart
  Manager: **Copies on my other PCs** (a project's git window: tick it, and it goes with the node backups every 10
  minutes when it changed; Back up now; Bring back into `restored projects`), **Start with a hire** beside Copy (a
  prompt, a project's prompt, a review, an audit's faults: TOMLIN's Send to card opens with the words), and
  **About › Bring in from Myia Bridge** (its folders, prompts, private details, set-asides, live addresses and fault
  lists copied in; that Bridge is only read). The stand-alone Myia Bridge stays a program of its own.
- **Push live (the Bridge, 2.0.49):** a project's **…** menu › **Push live…**. Off until turned on in that window (it
  is the one part of TOMLIN that sends a project out). **Connections** (kept in `data/bridge/hosting`, sealed by
  Windows for this account, DPAPI; never in a project, a chat, a prompt or an update backup):
  - **cPanel**: server name, user name and password; the password is used once to make TOMLIN's own API token
    (Tokens::create_full_access, named TOMLIN_<PC>_<date>), then dropped. Or paste a token (two-step sign-in).
    Disconnect deletes TOMLIN's token in cPanel. Every call is a POST, so no value lands in the host's access log.
  - **FTPS** through Windows' own `curl.exe` (the password goes to curl over its input, never on a command line).
    Plain FTP is refused.
  - **SFTP** through Windows' own OpenSSH: TOMLIN makes a key and shows its public half to add in the host's panel;
    the server's key is remembered on first use and a changed one stops everything.
  **Set up** picks the site (cPanel: one of the account's domains, optionally a folder inside it; FTPS/SFTP: the web
  folder and the address) and the upload folder (guessed: public_html, public, htdocs, www, site, dist, build, web).
  **Push live** checks first (never sent: .env, .git, node_modules, keys, AI working notes; data/, logs, backups,
  .sql only when ticked; a key, a written-out password, a saved secret's value, a private detail or a path on this
  PC stops it with file and line; "Not a secret" sets a line aside until it changes), then sends only new and
  changed files, removes only files it sent before, keeps a copy of everything it replaces or removes (cPanel: in
  `~/tomlin-push-backups`, the last 3 pushes; FTPS/SFTP: on this PC), writes the Live secrets to
  `tomlin-secrets/<site>.php` outside the web folder (owner-only, 600) with `tomlin-secrets.php` (no values) in the
  site to load them, asks the live site for /.env, /tomlin-secrets.php and /.git/config (no secret may come back),
  and sets the site's address as the project's live address with its light. **Go back** undoes the newest
  push's files (also a push that stopped part way); the Live secrets and a database stay as they are.
  **Secrets…**: names with a Local value (given to the local copy the Bridge starts, as environment variables) and
  a Live value; the page never gets a value back. In PHP: `@include __DIR__ . '/tomlin-secrets.php';` then
  `getenv('NAME')`. **Database…** (cPanel): makes the MySQL database and user with a generated password (Live
  secrets DB_HOST, DB_NAME, DB_USER, DB_PASS) and loads a .sql file of the project (up to 64 MB) through a one-time
  page with a random name and key that deletes itself and the file; it needs the site's https. Code:
  `src/bridge/hosting/`, `src/bridge/routes/hosting.js`, `public/bridge/js/hosting.js`; test
  `test/bridge/hosting.test.js` (stand-ins on this PC: a cPanel, an FTP server, sftp.exe).
- **Top bar:** how busy the CPU and the graphics chip are (GPU %), RAM and graphics memory (GPU mem), refreshed every second, plus what is loaded and how much memory it holds.
- **Chats:** **+ New chat** (left panel, top) asks who the chat is with (TOMLIN and each hire who chats), each
  with role · model · PC. The previous chats are in the **Chats** tab on the right of the chat, under the project each
  belongs to (the project with the newest chat first, then Default), each as [staff] subject, newest first: click one
  to carry on. The **…** button beside the chat's name renames or deletes it; deleting asks
  whether its pictures go too or stay under "All chats". Each chat is its own file, `data/chats/<id>.json`, listed in
  `data/chats/index.json`. The first start after the update turns each older one-file-per-person chat into one chat
  (the old files are left where they were).
- **Tools (right of the chat, the tab beside Chats):** **Subject name**, **Project** (the open chat's to start with)
  and **Create new subject** start one with the person open now, named for what it is about ("blog photos", "shop
  icons"), in that project; a name they already have in that project opens that subject instead, and a chat still
  empty and unnamed takes the name rather than leaving a second one. Each subject keeps its own messages and, with an
  artist, its own pictures. A subject is a named chat, so it is listed in the Chats tab. On a narrow screen the panel
  folds to one line above the chat.
- **Scratch pad and Snippets (global) (in Tools, under Create new subject):** the scratch pad keeps notes as you type ("Saved" beside its
  title); Snippets (global) keeps prompts or notes to use again: type one and press **Save** (Ctrl+Enter). The save icon
  in the top right corner of the message box opens **Save to prompts (global)**: an optional subject and the prompt
  (what is in the message box). **Browse** opens a window with every snippet, grouped by subject, with a search box:
  **Copy** (one press), **Use** (puts it into the message box, after anything typed there) and **Delete** (with Undo).
  Both are the same in every chat, kept in data/notes.json; no model reads them unless you put one in the
  message box. Each folds to its title (Hide / Show); a wide screen remembers which is folded. **Save note** files the
  scratch pad in the workspace: in `notes\` (Notes), or in a project's `admin notes\` (pick the project beside it),
  named with the date and time and its first words.
- **Copy a message you sent:** the copy icon in the top right corner of your message puts its words on the clipboard
  (a tick shows for two seconds). **Copy** under every reply does the same for the whole reply (paste it in the
  Scratch pad, or anywhere).
- **While a reply comes:** "<name> is writing a reply" with three moving dots. The chat's head shows the **average
  speed** of its replies ("Average 12.4 tok/s"; the tooltip says how many were timed).
- **The message box:** drag the grip on its top edge, or its bottom right corner, to make it taller or shorter;
  double-click the grip to put it back. The height is kept in this browser.
- **Send to… (under every answer):** a card with the answer's words (or only the part picked
  in it) to change first, **Copy** (to paste anywhere), and **Write it as a prompt for…**: the chat model connected
  here rewrites the words as what that person works from (a picture prompt for an artist, an icon prompt for the
  graphic designer, a brief for the coder or the writer, a goal for the project manager, a plain request for anyone
  else; the instruction is picked by code from their role), with **Back to the words as they were**. **Send to**
  lists artists and staff; **Into subject** opens that subject with them (or makes it; blank =
  their latest chat). Send opens the chat and sends at once: an artist draws it, anyone else answers, and a model
  that is not loaded loads first (asked only when it does not fit). The message that arrives says **Sent from …** and
  the answer it came from **Sent to …** (written by the app, never sent to a model). The blog writer's **Add a
  picture to this post** writes the picture prompt and opens the same card first: **Draw it for the post** draws it
  as the artist picked (or the picture model connected here) and adds it to the post; sending it to anyone else
  leaves the post as it is.
- **Long answers and long chats:** an answer may take a quarter of the model's context (2,048 tokens at the 8K
  default, 8,192 at 32K, at most 16,384). An answer its limit cuts off says so with **Continue**, which carries it on
  from the very character it stopped at (mid-code included) and joins the rest onto the same answer. When a chat fills
  about 75% of what the model can read, a bar offers **Write a handoff and start fresh** (the model writes what the
  work is, what is decided, done and open; a new chat with the same person opens with it, folded at the top, and reads
  it with every answer) or **Ignore** (asked once more at 90%). The chat settings show how long a full context takes
  to read on this PC, from the reading speed measured on that model's own answers here, and warn past 10 minutes.
- **Big contexts (up to 262,144):** a message can be up to 1,000,000 characters (it was 20,000), so a whole file can
  be pasted; one bigger than the model's context can read is not sent, and says how big it is and what this context
  takes. While the model reads, the answer's place says how far it has got ("Reading the chat: 50% (5,447 of 10,895
  word-pieces) · about 2 min left"), on this PC or a linked one. The start of what each turn sends stays the same as
  the chat grows (past full, the older messages drop off a third of the room at a time, not one every turn), so the
  model reads only what is new: measured here with Qwen 3.5 0.8B, a second turn read 23 new word-pieces in under a
  second instead of all 3,873 again (56 s). A chat that comes to more word-pieces than the model holds (JSON and lock
  files are nearer 2 characters each than the 3 TOMLIN counts) is cut down to the model's own count and sent once more.
- **Quick or Think (2.0.31):** beside Send. Quick answers straight away (thinking stays off). Think lets a model that
  can think (Qwen 3 and 3.5) work the question out first: the working streams into a fold above the answer
  ("Thinking first… 12 s", then "Thought for 40 s"), is kept with the answer and never sent to the model again. The
  answer gets 4,096 more tokens of room for it. A model that cannot think answers straight away and says so; reasoning
  models (DeepSeek R1, QwQ) always think and always get the room. The choice is kept per chat. A hire on a node's model
  thinks there (an older node answers straight away and says so). Job steps stay as they were.
  While it works, **Answer now** stops the working and asks for the answer with the working so far. The app stops it
  by itself when the working goes round in circles (the same paragraph, sentence or 40-character line again) or runs
  past about 12,000 characters; the answer is then asked for with the working, and a note under it says why. Measured
  6 Oct on the 2-core test laptop under load: Qwen 3.5 2B thought for 13 minutes about 12 pens at 3 for 2 euros
  (round in circles; its working reached 8 euros, the plain re-ask said 48, which is why the working now goes with
  the re-ask); with Answer now after 82 s it answered 17 x 23 = 391. Small models overthink: on a 2B, Quick is often the
  better choice.
- **Connect Claude (2.0.31; 2.0.44):** a small button at the right of the Home heading: "Claude can be your project
  manager, splitting a project up into chunks that your cluster can handle." **Copy prompt**: Claude as the project
  manager of the network; this copy's folder and newest handover, your data folder (never to be changed), this PC's
  port and node state; this PC's own API for the linked PCs, staff, projects, subjects and the queue (this PC holds the
  links, so Claude never needs a PIN or a setup code); and how to work (scratch copies for tests, never your copy). The
  prompt holds no PIN, setup code or link key (src/claude.ts builds it from fields that have none).
- **Documents in a chat:** **Add a document** (or drop a file on the chat) puts a PDF, text or code file into the
  open chat with TOMLIN or a hire, up to 25 MB and 8 documents a chat. It is read once into plain text, split
  into parts of about 300 words (never across a page) and kept beside the chat in `data\docs`; the file itself is not
  kept. When every document in the chat fits in two fifths of what the model can read, they are given whole, the
  same every turn (a code file read in parts is not code; the line under the answer says "Read: app.js (whole)").
  Otherwise, for each message the parts that match its words best (a page named in it, "page 31", first) are given
  to the model, up to two fifths of what it can read; the answer is asked to quote and name the page, and the line under it
  says which pages it was given ("Read: manual.pdf page 31"). A scanned PDF (pictures of pages, no text) has nothing
  to read and says so. PDF text is read by PDF.js (THIRD-PARTY.md). A carried-on chat keeps the documents; deleting
  the chat deletes them. Not for a hire on another PC.
- **A hire's own models, here or on a linked PC:** in **Team**, each hire has a **First choice** and a **Fallback**:
  a model on this PC, or one of the models a linked PC lets other PCs use ("Qwen3.5-9B on "Worker PC""; it loads
  there when asked, and while it answers another PC this one waits), or (an older PC) whatever that PC has loaded. A message to the hire goes to the first choice if it can
  answer now, else to the fallback if it can, else to whichever of them can be loaded here (it loads, and the chat
  says so). A hire with no model given answers on the model connected here, as before. The whole chat is sent over
  and the answer streams back; the chat itself is kept only on this PC. The chat head and each answer say where it
  ran ("With Rowan · Coder · on laptop 0.8B"); when the fallback answered, the answer says why. Job steps in a
  hire's role run on that hire's models too (each job's Overview, under Roles, says who really does each kind of
  step).
- **Backup when a PC is off:** when neither of a hire's models can answer (their PC is off, busy, or the model is
  gone), the chat asks where they should answer instead: this PC's models that fit and each linked PC that is on with a
  model loaded, the same model first. **Just this time**, **Until their PC is back** (dropped once their own model
  answers again) or **Always their backup** (it becomes their fallback); the message is then sent. A smaller model
  answers as an intern: the chat head says "intern", and in a job it takes no step across several files.
- **Speed:** every answer is timed (tokens written a second, prompt read a second), here and on linked PCs (a node
  sends its figures back with each answer; an older node sends none). **Test speed** (Edit Staff, Nodes and
  memory, Staff on other PCs) runs one example prompt and keeps it as the baseline. Rows show the expected speed: the
  average of the last real answers once there are three (from the last 30 days), else the test. Kept in
  `data/speed.json` (src/speed.ts), numbers only.
- **Compare models** (a hire's chat head): the first choice and the fallback side by side. Each
  can be changed, auditioned on the role's three set jobs (a model here is loaded for it; a linked PC answers on what
  it has loaded), and **Make this the first choice** swaps them. Each model keeps its last audition score.
- **One pane per person (2.0.28):** a chat with the host or a hire is the chat alone; an artist's chat (an artist or
  designer, here or on a linked PC) is the pictures pane alone, with their name at the top, **What should Clara
  draw?**, Connect beside their picture model, the picture, and the chat's gallery. What is typed there is drawn
  just as typed: no chat model rewrites it first (**Enhance prompt** does, only when pressed). The first thing asked
  names the chat. A picture asked for in any other chat ("can you draw a lighthouse", "/image ...") is not drawn there:
  the app answers, without a model, with which artist to open.
- **Pictures over the home network:** a picture asked for in an artist's chat is drawn by the artist's first choice
  or fallback; with none given, here when the picture model is connected, else by a linked PC that has a picture model
  loaded. The prompt and a **style** (Cartoon, Photo or Icon, from the words, else the artist's **Preferred style**
  in Team) go over; that PC draws one picture and sends it back; it is saved here in the open chat, and that PC keeps
  no copy. The picture says where it was drawn ("drawn on laptop DreamShaper 8 LCM").
- **An artist PC:** it draws on the picture model its owner connected; nothing loads by itself (with no picture
  model connected it says no). A style its loaded model is not made for switches to another model on that PC that is
  (Realistic Vision for Photo, DreamShaper for Cartoon, about 5 s): a linked PC is trusted, so there is no tick for it.
- **Pictures belong to their chat:** a picture drawn in an artist's chat (or for a blog post written from a chat)
  carries that chat in the gallery. An artist's chat shows **This chat** (only that chat's pictures) or **All chats**,
  and opens on **All** (drafts too). A chat with someone who left the team can still be read, not carried on.
- **How big a job step can be:** a step reads all its files; how much depends on the worker's context (about 8,100
  characters at 8K, 19,500 at 16K, 44,700 at 32K, 92,800 at 64K). Files that fit its answer (a third of the context
  from 16K up) come back whole. A file too long for that is changed with find-and-replace blocks: the worker copies
  the lines to change and gives their replacement, and the app makes the change only when each block matches exactly
  one place in the file (spaces at line ends forgiven); a block that matches nothing, or several places, is refused
  and the worker is asked again (up to 3 tries). A file too big for any worker to read still stops with words.
- **Live preview:** in the job window, **Live preview** shows a page of the workspace (an .html file the job's steps
  name first) beside the steps on a wide screen, under them on a narrow one, and reloads by itself when a file in the
  workspace changes (a step saved, or a change in Files). The page runs its own scripts in a sandbox: it cannot call
  TOMLIN or any other address, load anything from outside this PC, or send a form. It is served only to this
  PC, at an address with a key made at each start.
- **Log file:** what went wrong (a model that would not load, a chat or job step that stopped, a fault in a request)
  goes to `data\logs`, one file a day, the last 7 days kept. It holds where and what, never chats or files. Help >
  **Open the log** opens today's.
- **Projects and Jobs:** Home's **Lets create a project** takes a name, a folder, a mini description, the prompt and
  who leads it; **Lets go!** has them plan it. In Jobs, each job's Overview says who plans and who does the code, the
  words and the audit (Roles), with the Scope card and the design brief to copy or change; **LETS GO!!!** runs the
  steps. Every job keeps its events in `jobs/<id>/events.jsonl` in the workspace (job rooms were dropped in 2.0.36).
- **Nodes and memory** (Set up, in the left list; also a card on Home while nothing is set up): this PC as a node,
  the linked PCs as tiles (three across on a wide screen: On / Asleep / Off, their memory bar, the models each lets
  this PC use under Standard and Images, one a line, speed), and every model on this PC with its speed. This PC's own memory and loaded models are in the
  top bar. Nothing loads by itself. A model you load stays loaded until you drop it (Drop in the top bar) or another
  model needs its place: a new one goes beside the loaded ones when it fits, else the least recently used one that
  is not answering makes room. On a node, a model loaded because a linked PC asked for it is dropped by itself when
  no linked PC has used it, or had a chat with it open (the 3-second meters), for 60 seconds.
- **The host is switched off for now (2.0.31):** the separate assistant that was there before anyone was hired is
  hidden (people found it confusing). Everyone you talk to is someone you hire; a new install says "Nobody to talk to
  yet: hire someone first". Old chats with the host stay in the list to read. One switch in src/server/core.ts (HOST_ON)
  brings it back. The chat's Connect row shows the model of the chat open now; when that one is not loaded it says
  Disconnected, even if another model is loaded for someone else (every loaded model is in the top bar).
- **Left list:** **Home**, then the chats, then **Staff (n)**: each person you hired, with their role, model and state. **On** (filled dot): their model is loaded. **Waking up** (spinning ring): it is loading. **Asleep** (ring):
  it is on this PC but not loaded (Connect loads it). **Not set up** (dashed ring): no model given. Linked PCs
  show **Off** (crossed ring) when they do not answer. A number on a row counts work of theirs waiting for you.
  Click a person to talk to them (an artist or designer opens their chat, in the pictures pane). **Set up** also
  opens **Jobs** and **Files and blog writer**. On a phone the list is the first screen, and **‹ Chats and staff** goes back to it.
- **Home:** **Waiting for you** sits in a panel on the right (a job step that came back, a picture to draw, failed
  tests, a finished job to review), with **Working now** under it: who is on which job step, who is answering in a
  chat (here or on a linked PC, with **Open the chat**), a picture being drawn,
  a model waking up. **Hide** folds the panel to a thin strip that keeps the number waiting and says how many are
  working; **Show** (or a click on the strip) opens it again, and the choice is kept in that browser. On a narrow
  screen it sits under the ask box. Beside it: **Paused jobs**, and a box to start a job. Every line is written by the program from the job's plan file, never by a model. A step that
  came back stays waiting (saved as `jobs/<id>/waiting.json` in the workspace) until you save or discard it, also
  after a reload.
- **Each pane:** model, **Run on** (Auto, GPU, CPU), **Connect**. **Settings** has CPU cores to use (fewer keeps the
  PC responsive; applies from the next Connect) and an optional idle unload, off by default.
- **Auto:** an NVIDIA or other separate graphics card is tried first, then the CPU. For chat, a graphics chip built
  into the processor is skipped (on an Intel HD 520 the CPU was four times faster at reading prompts). For pictures,
  it is used (there it was six times faster than the CPU). If the graphics chip runs out of memory while drawing,
  the picture is drawn again on the CPU and the page says so.
- **Where a chat model runs on a graphics card** (chat Settings, shown on a PC with a card of its own or for a
  mixture-of-experts model): **Auto** (the default) lets llama.cpp fill the card, or every card, from their real free
  memory and put what does not fit in RAM, the experts first on a mixture-of-experts model. **Every layer on the
  graphics chip** puts it all on the card. **Expert weights in RAM** keeps every expert in RAM and the rest on the card.
  The memory check counts the cards' memory, so a model bigger than the RAM but within the cards is not called too
  big. **Try each way** loads the model each way, asks for about 80 words each time and keeps the fastest (the way
  before stays unless another is at least 5% faster); a big model takes minutes per way.
- **Pictures:** write a prompt. A size in it ("120px x 120px", "600x600") becomes the picture's size and is taken
  out of what the model sees. The model always draws at about 512×512 pixels in that shape, then the picture is
  resized (Lanczos). The mode is chosen from the prompt, and you can change it:
  - **Icon** ("icon", "logo", "favicon", or 256 px and under): flat icon words are added, the background is cut
    away, and the icon is centred on a see-through PNG. Advanced has an option for 16–256 px sizes plus an .ico.
  - **Blog / photo** ("photo", "blog", "hero", "realistic"): photo words are added and 4 drafts are drawn. Press
    **Finalise** on one: it is drawn again with the same seed, more steps and the full-quality decoder, then saved as
    WebP (60–120 KB). If a chat model is connected, it also writes alt text, from the prompt.
  - **Cartoon** ("cartoon", "comic", "anime", "caricature"): flat colours and clean outlines are added. It looks
    best with DreamShaper 8 (a photo model like Realistic Vision follows it less well); the line under the prompt says
    so when another model is chosen.
  - **Custom:** your words only.
  - **Profile pictures:** "cartoon profile picture of a friendly baker" (also "avatar of …", "headshot of …"),
    in an artist's chat, draws a square head-and-shoulders picture (512×512 when no size is given). The words go to
    the picture model as typed; no chat model rewrites them.
- **New chat starts clean:** a new chat (or opening another one) shows no messages and no pictures; an artist's chat
  always opens on **This chat**, and **All chats** shows every picture until the next chat change.
- **Linking PCs (Nodes and memory):** on the PC that lends its models, tick **Enable this PC as a node**; its Setup
  shows the name other PCs see, its **setup code** (8 letters and numbers, its own, kept; **New code** makes another)
  and, only if you tick it, a PIN as well; the port is under Advanced. On your main PC, Nodes and memory > Other PCs >
  **Find PCs on my network** lists the PCs with it on; type one's setup code (and PIN, if it asks) and press **Link**.
  Not found? Type its address instead. A PC linked again keeps the hires on its models (each node has a fixed id).
- **Private nodes (2.0.26):** the link between two PCs is encrypted. At linking each PC makes a fresh key pair
  (X25519) and both prove they know the node's setup code (and PIN) without sending it, so a device in the middle
  cannot join; every message after that (the words, job steps, pictures) is sealed with AES-256-GCM both ways, and a
  changed, replayed or misdirected message is refused. A PC linked before 2.0.26 must be linked again; an older
  TOMLIN is told to update. The node's page shows only "Answering for <that PC>" / "Drawing for <that PC>":
  a picture drawn for another PC is made in memory and never enters the node's gallery. A node **must have the app
  lock**: it cannot be turned on without a PIN, every change to it asks for that PIN again, and the lock cannot be
  turned off while it is a node (without the PIN file the node stops listening). The node never gives way by itself:
  Nodes and memory has the button **I need to use the pc and stop smartmanager for a while** (behind the PIN), and
  its lock screen has **Send host**, which asks the main PC to log out for 1, 2 or 4 hours (no PIN; the main PC
  decides, and a yes ends by itself when the hours are up). Logged out, it takes no new work, lets a running step finish, unloads its models, and the main PC is
  told "I need to log off for now" and sends work elsewhere. The main PC's **Start it again** asks first within an
  hour of the press, and after an hour just starts it (its models load again). **Start TOMLIN when this PC
  starts** puts one small file in this Windows user's Startup folder; unticking removes it. Limits: whoever controls
  the node's Windows account could still read its memory while it works; the PIN file can be deleted while Smart
  Manager is closed (the node then stops); Windows may still put the PC to sleep.
- **Models other PCs may use (2.0.30; picture models 2.0.31):** a node just downloads models and chooses which are
  accessible. On the node, Nodes and memory, under Enable this PC as a node, tick the chat models (they answer) and
  picture models (they draw) linked PCs may run and press **Save the list** (it asks the app lock PIN once). On the
  main PC (or any linked PC), hire staff as usual, pick that PC and one of its models in **Hire staff** (or First choice
  in Edit Staff): "Qwen3.5-9B on "Worker PC"" for chat staff, "DreamShaper 8 LCM on "Worker PC"" for an artist. Who
  they are, their notes and their chats stay on the PC that hired them; the node loads the model when it is asked for
  (a chat model beside its loaded ones when it fits; a picture model in place of the one loaded when that one is not
  drawing) and works for one PC at a time on each model, so a second PC waits while it is busy (the chat or the
  picture says so). A model the node loaded for a linked PC is dropped after 60 seconds unused. A chat with such a
  hire shows that PC's CPU, GPU and RAM under its head. Other PCs > Linked says what each node lets this PC use, and
  which of them are busy now; a hire's row says when their model there is busy for someone else.
- **Busy for linked PCs (2.0.31):** the node's Nodes and memory says which of its models linked PCs are using now
  ("… is answering "Laptop"", "… is loaded for …"). When someone at the node sends a message, draws a picture or
  presses Connect in a way that would touch that work (their model answering, or pushed out of memory), a window asks
  first: **Using this can impact connected users**, with why, and an **I agree** tick before **Go ahead**.
- **Staff hired on a node and lent out are retired (2.0.31):** linked PCs no longer lend their own staff (Work for
  linked PCs, Remote staff, Switch are gone). An old chat with one is kept to read and says how to carry on: hire
  someone on that PC's models here. A main PC from before 2.0.31 asking for one is told the same.
- **What linked PCs may do, and the node network (2.0.32):** on a node, Nodes and memory, under **What linked PCs may
  do** (below **Models to share with others**, the list once called "Models other PCs may use"): **Allow all**, then
  **Sharing of models** (linked PCs may copy the models ticked to share), **Host can back up** (since 2.0.44 **Enable backups**: a linked PC may keep a
  restore point there: a zip of its data/, the newest 3 from each PC, in the home folder's "backups from other PCs")
  and **Allow host to push models** (a linked PC may install one of its models in this PC's chat models folder; it is
  not shared until ticked). All off until ticked; each change asks the app lock PIN. A PC keeps listing and bringing
  back its own restore points after the backup tick is taken off. On any PC, **My local LLMs**
  (Nodes and memory > Other PCs, and the Models page) lists every model the linked PCs share, once each, with **Get a
  copy from …** (or why not: that PC is off, older, being used, lets others use but not copy, or it is an Ollama
  model), **Send one of yours to a linked PC**, and **Restore points on linked PCs** (Back up to it now; Restore points
  kept there, Bring back into this PC's backups, then Settings > Your data and updates > Put back). Files cross the
  encrypted link in sealed 16 MB pieces (src/carry.ts): a copy cut short carries on from where it stopped; Stop on a
  send clears the half-sent file on the node; one copy at a time with each PC; 2 GB is always left free on the disk
  that receives. Measured on one laptop (both copies on it): 508 MB in about 10 s.
- **Installer (2.0.34):** `Install TOMLIN.cmd` runs `tools/install.ts` (install, update, repair; `uninstall`
  from Settings > Apps); its plain parts are in `src/installer.ts`, the program in `tools/tray.cs` (built on the PC by
  `csc.exe` from .NET Framework 4, which every Windows 10 and 11 has; a job object ends TOMLIN and its model
  runners when the program ends), the icon in `public/icon.ico` (`node tools/make-icon.ts` from icon.svg). The release
  and every pushed update carry `runtime/node` (this PC's own Node.js, copied by `npm run fetch -- node`; `npm run
  pack` refuses without it). An installed node that is updated from the main PC: Smart Manager.exe starts the new copy
  and moves current.txt on; Start with Windows points at Smart Manager.exe and so never goes stale. Closing a running
  TOMLIN during install or uninstall touches only that install folder's program. Every place moves for tests
  (TOMLIN_INSTALL_ROOT, TOMLIN_START_MENU_DIR, TOMLIN_DESKTOP_DIR, TOMLIN_STARTUP_DIR, TOMLIN_UNINSTALL_KEY);
  `--dry-run` says each step and changes nothing.
- **2.0.49:** **Push live** in the Bridge (see The page): one press to cPanel, FTPS or SFTP, secrets kept locked by
  Windows and written outside the web folder, a check that stops keys and private details, Go back, and the MySQL
  database on cPanel. The address it goes to becomes the project's live address. Licence: PolyForm Noncommercial 1.0.0.
  Two linked PCs with one name show their address on their cards (and linking the second says so); a PC that answers
  with nothing loaded says Asleep; a queued chat message stopped with Stop is sent again on Resume; half-sent updates
  are cleared; a PIN file holding nothing keeps the app locked. Tidying: the second look's files and Start Shelby.cmd
  are gone (SHELBY_* settings are still read, for PCs whose launcher started before the rename).
  Push live, hardened: two sites in one secrets folder each get their own Live secrets file; a saved secret inside a
  big binary file stops the push; files left out by .gitignore and sent with the tick must all be seen, and a file
  that cannot be read stops it; Set up, Secrets, the database and Disconnect wait while a push runs. Two queued chat
  messages with the same words are both sent; a site picture's hidden Edge is stopped even when it is too busy to answer.
  A full disk is said plainly (which drive, and what to do), and a save it stopped never shows as done; a database
  load cut off part way says some of it may be in; the scratch pad never saves over words another window saved.
  Big contexts: messages up to 1,000,000 characters, documents whole when they fit, the reading shown as it goes,
  only what is new read each turn, a chat over the model's count cut down and sent again. Settings: the Set up menu
  stays on the left on every page it opens, and Staff, Jobs and Files are pages there, not windows.
- **2.0.51:** Moving someone to a PC refuses a model only when it needs more than 5% over all that PC's memory (the
  need is an estimate and runs high); just over, it is a tight fit. A PC's card in the left panel has a yellow (!) when
  95% or more of its RAM is in use (this PC and linked PCs), with the figures on the (!).
- **2.0.50:** The office's boardroom and lounge start empty in every office, and the tokens your staff write buy the
  furniture piece by piece (Look after the team, a menu of picture cards beside the office): with no table a long think stays at the desk, each
  pair of chairs seats a helper, and an empty lounge sends the idle to the kitchen. Deck chairs with umbrellas on the
  beach: a hire with nothing to do for 10 minutes takes a break there, shown apart from a PC that is off (On a break,
  a green cup, sitting up; PC off, a grey power mark, lying on a towel), on the office and on their Staff overview card.
  Press the employee of the month's frame: who won, and this month's tokens by person (a pie). **Update this install**
  (Nodes and memory): upload a newer TOMLIN zip and it starts in place of this one (the old copy stays beside it), then
  **Update all linked PCs**; a linked PC behind this one has a yellow (!) on its card in the left panel. A chat in the
  left panel has a … for Pin / Unpin and Delete. The Set up menu no longer folds. Staff: hire and edit opens Hire staff
  (See all staff beside Close for editing); under Choose a model, **All models** lists the models on your other PCs that the
  PC picked has not got, with Copy to it (a model on another linked PC goes through this PC), then hire on it.
  Moving someone to another PC (the office or the left panel) offers only the models that fit that PC's memory (its RAM
  with 3 GB kept for Windows, plus every graphics card's own memory); the others are named with what they need, and the server
  refuses such a move too. **Welcome to TOMLIN.html**, at the top of the zip, says what TOMLIN is, what it does and
  what it needs before installing (it works offline, with Help's pictures). Help is rewritten in two parts, one PC
  first (models, hiring, saving your work), then your network (a node, moving staff, backups, models and software,
  git, scanning), with screenshots.
- **2.0.48:** Layout passes 1 and 2: the chat head is a staff card (name and software over the PC, avg speed,
  rename in place, Project beside it); **Enable live stats** in the gear; Copy, Pin and Send to as icons; the top bar
  keeps this PC and shows a linked PC beside it with its model; staff rows "Name | Level" over the software; pressing
  a hire opens New chat and their recent chats; the Staff window has Look, Staff settings and PC settings tabs, a PC
  card, moves with fit warnings, a compact Look editor with Save, Fire in a pop-up. The office shop (coffee, donuts,
  gym equipment, paid from tokens written). The Move window is a centred pop-up like Fire's. Installer: Task Manager
  and notifications name the program TOMLIN; the tray's "Open the TOMLIN folder" opens the real data folder again;
  "Install TOMLIN.cmd" opened from inside the zip says to unzip first. The Images window says which PC is busy when
  a picture is already being drawn on another one.
- **2.0.47:** **Backups only**, a tick on each linked PC's card (Nodes and memory, Other PCs): a PC kept for backups (a
  storage box). No staff, chats, jobs or pictures run there and no model is copied to it (hires on it are moved off,
  after a question naming them); it is first in line for project backups. Each PC's backup disk (size and free space)
  shows on its card and in the Bridge's **Back up to** list, with its RAM and graphics card, so two PCs with one name
  can be told apart; a PC whose disk cannot hold the backup is skipped and says why.
  Each project in the Bridge says **Local backup: off**, **not yet**, **on** (with the last date) or **out of date**;
  pressing it opens its window, and backs it up at once when it is on.
- **2.0.46:** A project's git window (Projects) is wider, in two halves: git on the left, **Copies on my other
  PCs** on the right (one column on a narrow window). **Back up now** says everything inside the window: "Backing
  up…", each PC's progress once a second, then what each PC answered; **Back up to** ticks each linked PC (named
  with its address, as two PCs can share a name). The built-in audit rates a fault in a file git ignores as a
  warning (it stays on this PC); anything git keeps or would add, and any folder without git, keeps its rating.
- **2.0.45:** The name TOMLIN: icon, installer, shortcuts, window and notification titles; **Start TOMLIN.cmd**
  (Start Shelby.cmd only runs it, for old shortcuts); settings TOMLIN_* (SHELBY_* still read); new copies in
  `tomlin-<version>` folders (`shelby-` copies still recognised). Bumped so linked PCs on an earlier 2.0.44 can be updated.
- **2.0.44:** Updates you can watch, a lock screen that asks, and Chats | Tools.
  - **Projects: Myia Bridge built in** (left panel, under Home; see The page). Project backups to nodes now take the
    projects ticked **Copy to my other PCs** too, each in `Bridge projects/<folder name>/` of the backup (a git project
    sends what git keeps; a file over 256 MB is left out and named). Its tests run with `npm test`
    (`test/bridge/*.test.js`); `tools/bridge/` holds its scanner tools (benchmark, calibrate, disclose).
  - **Repair install** (src/repair.ts; My PC's Install part, the icon's menu, `node tools/install.ts repair`): an
    update reaches only the copy that RUNS, so a copy started from a folder (Start TOMLIN.cmd, or a Start with Windows
    entry made from it) took the updates while the install kept its old copy, and Smart Manager.exe then "failed to
    load" (its copy found the port taken). Repair copies the running copy in (never the source folder), builds the
    program again, points current.txt, the Start menu and desktop shortcuts, Start with Windows and the Apps entry at it,
    and lists what it would do first; **Start the installed one now** hands over (Start TOMLIN.cmd ends with 78). My PC
    also has **Shortcut to desktop** and **Start on start up** / **Cancel start on PC start up**. A copy that finds
    TOMLIN already running ends with 77, and Smart Manager.exe then opens the one that runs (and says so) instead
    of a failure; it also checks the port before starting at all. Start with Windows from a folder copy starts the
    install's program when the install is whole and not older.
  - Home's right panel has two tabs, **Waiting for you | Staff overview**, and runs down the window's right edge with no
    gap (the main column scrolls on its own); the chat's panel is **Chats | Tools | Staff overview**.
  - **Update it** opens its own screen: Comparing the files, Sending what changed (with how much), Starting the new
    version there, Checking it answers; each step is ticked only once it has really happened, and **Keep this window
    open** shows until it ends. The node's screen says the same while the update comes in and while it starts.
  - A PC whose folder changed after its TOMLIN started (a newer version unzipped or built over it) refuses to
    send an update at once and says to start it again; before, the node refused at the very end ("does not say the
    version it was sent as").
  - The lock screen: **Access is restricted.**, **Unlock** [PIN], and on a node **Send host** [I need to use the pc,
    please log out for 1 / 2 / 4 hours]. The main PC gets a notification and a line on Home's Waiting for you with
    **Log out for N hours** and **Not now**; the node shows the answer. Yes logs the node out for those hours (no new
    work, its models unloaded once the work running there finishes) and it starts again by itself. Nodes and memory
    no longer has a button that logs out at once; while the node is logged out it shows **Start it again**.
  - Moving a hire to a linked PC that offers nothing to run them on says: "The staff can't log in to this machine, go
    to the machine, and check its permissions."
  - **My local LLMs** (was See what's available on node network); the Models page's filters are **All** |
    **Not installed** | **Installed**, with My local LLMs on the same line.
  - **Chats | Tools** on the right of the chat: Chats lists every chat under its project (then Default), each as
    [staff] subject (the list moved from the left panel); Tools is the old Subjects part (Create new subject, now with
    a **Project** picker that starts on the open chat's project, or carries the last one into the next person's empty
    chat), then the Scratch pad and Snippets. A subject belongs to its project: the same name with the same person in
    another project is another chat. A project saved on Home and not planned yet can hold chats too.
  - **Nodes and memory, new words:** Node name, Setup Code, "Enter the setup code into the other PCs to allow them
    remote access."; the share list has **Select all** and the headings **Standard models** / **Image creation
    models**; the busy line shows only while a linked PC uses the node; the ticks are **Sharing permissions:** Sharing
    of models, **Enable backups**, Allow host to push models, **Allow host to update TOMLIN remotely**.
  - **Project backups to nodes (Enable backups):** the main PC's workspace (its projects) goes to each node that keeps
    backups as a commit in a local git repository there ("backups from other PCs/<pc>/projects.git", a normal bare
    repository that git, GitHub Desktop or VS Code open). Every 10 minutes when something changed, or **Back up
    projects now** in My local LLMs; only files the node does not have yet cross (sealed, in 16 MB pieces), each one
    checked against its git id before it is kept; .git and node_modules folders are left out; at most 100,000 files.
    **Bring projects back** copies the newest backup into a new folder, "restored projects/<PC> <date time>" (nothing
    in the workspace is replaced). On the node, Nodes and memory lists the projects kept there with **Save a copy**
    ("projects from other PCs/<PC> <date time>"), for when the main PC is gone. Written with Node's own zlib and
    SHA-1 (src/gitstore.ts), no git program needed. Restore points (a zip of the data) stay under the same tick.
  - **A model sent to a node is shared at once** (ticked under Models to share with others), so a hire moved off the
    node and back finds it.
  - **Models on this PC:** tiles three across under Standard models, Image creation models and Hidden, each with
    Test speed (chat models), **Hide** / **Unhide** and **Delete** (asks first and names the hires who use it; not
    while it is loaded, hidden, or an Ollama model, which is removed in Ollama). A hidden model keeps its file and
    speed tests, can still be shared and copied, and is left out wherever a model is picked (Hire staff, Edit Staff, the chat's model list, moving a hire) until **Show hidden** is ticked beside that list.
  - **Test speed** works on a model of this PC again: it stopped itself (the test held the runner as a chat, and the
    model's answer stops the chat on its runner). A test that fails says why under its own tile.
  - **The PC window:** one top line, a connected light, the PC / its memory, its version ("Up to date: Last updated
    <date>", or Outdated with **Update it**); Uptime is hidden for now; "Nodes token logs:", **Total**, **Not allocated
    to a project**, shorter power lines; "Its settings" only in this PC's own window. The update screen is wider and
    ends without "It ran …".
  - **Settings** (top bar) puts the **Set up** menu at the top of the left panel, alone (no PCs, staff or chats); every
    other page leaves Set up out of the left panel. The top bar's **Models** is gone (Set up > Add a model).
  - Home: **Lets create a project** is Project name | Project folder | **Folder location** (where the project goes on
    this PC, and Change the workspace folder); with nobody hired: "Hire staff (staff connects a LLM model to a PC or
    node)."; the setup cards are headed "Setup progress N/4 start setup now:".
  - **Connect Claude**: "Claude can be your project manager, splitting a project up into chunks that your cluster can
    handle." The prompt makes Claude the project manager of the network and gives it this PC's own API (linked PCs,
    staff, projects, a subject with a hire in a project, the queue): this PC already holds every link, so Claude never
    needs a PIN or a setup code. The linked PCs to tick for Claude's tests are gone.
  - **The private chat is gone:** its chat, its PIN and its settings were taken out. Chats and pictures it left in the
    data folder are no longer shown, and an update no longer carries its files to the new copy.
  - **The Flirty writing tone is gone:** a hire or setting still on it writes in Natural.
  - **A fault before any answer stays in the chat:** when a turn fails before a word is written (a model that does not
    fit, "... needs about 23.5 GB", or one that does not load), the fault is kept under the message, so a reload still
    says why there is no answer. It is never sent to a model.
  - **The first hire's chat** no longer says "Nobody to talk to yet" when it is opened straight after hiring.
  - **A speed for every answer:** when llama.cpp's own timings never come (an answer ended early by the repeat check,
    Stop or Answer now), the speed is worked out from the streamed tokens and the clock instead of being saved as 0.
  - **What a model holds once loaded** goes in the day's log beside what was expected ("expected 2.2 GB ...; holds
    1.9 GB once loaded"), so a fit refusal that looks wrong can be checked against the real figure.
- **2.0.40:** An exact tally, and a start that repairs itself.
  - Prompt tokens taken from llama.cpp's cache are counted apart (the turn before's chat: no work, but an API bills
    it, at its cached price: Claude Opus 5.5 $0.20, GPT-6.1 Sol $0.10 per million); the API columns price them so, and
    say the cost without caching too.
  - Each linked PC logs the work it did for this PC per project; this PC takes that log as the final tally (every
    minute, and when the PC's window opens). A project's Overview: **Tokens and cost so far**, over every PC.
  - A start lock left behind by a crash repairs itself: a lock whose process is now another program (or started after
    the lock) is taken over; when Windows cannot say, the second start repairs it if nothing answers on the port.
- **2.0.39:** Uptime and costs. Press a PC in the left panel for its window: TOMLIN's running time and the PC's
  uptime, the share of the host's once-a-minute checks it answered (7 days), its total tokens, optional watts and price
  per kWh, and the estimated cost per project: power (working time only, never idle) against the same tokens at the
  Claude Opus 5.5 API ($4 / $20 per million read / written) and the ChatGPT API (GPT-6.1 Sol, $2 / $10), with the
  price per million tokens of each. Prices checked 7 Oct 2026, changeable there. Every PC counts its own work from
  llama.cpp's timings (data/meter.json); the host counts per PC and project (data/usage-ledger.json, data/uptime.json).
- **2.0.38:** Work that survives the host, and a place for each kind of work.
  - **Reconnect:** a linked PC (2.0.38 on) finishes an answer even when this PC loses it part-way (closed, asleep, off
    the network), and keeps it for three days, sealed with that link's keys. This PC asks again by itself for two
    minutes; then the chat keeps the words so far with "Lost the connection: <PC> is still working on it" and
    **Reconnect**. The answer is also collected at every start and once a minute, and put in its place. A job step
    cut the same way: **Run step** again collects the finished work instead of doing it again. Stop still stops it there.
  - **Folders:** a quick chat in Default saves into its own `chats\<date and time>` folder; putting the chat in a
    project moves those files into the project. In a project, the writer's work goes in `specialists\writer` and
    pictures kept in its chats in `specialists\images`, each named with the date and time. The project manager and the
    auditor read those folders, newest first, for the work handed in; the Overview lists it. Handoff cards are named
    with the date and time too.
  - **Save note** under the scratch pad: `notes\<date and time> <first words>.md`, or a project's `admin notes`.
- **2.0.37:** The hot desk, and chats in projects.
  - **Left panel:** each hire's icon has a dot at its lower left: green available, yellow busy, red its PC is in use
    by its owner, grey offline (each its own shape, with the word beside it). Under Staff, **PCs**: My PC and each
    linked PC with its memory ("32 GB RAM / 5 GB VRAM"), and the staff who work on it sitting on top of it. Drag a
    hire onto another PC to move them there: the window offers the software on that PC, or sends their model there.
    Nobody hired: **HIRE STAFF**.
  - **Home:** a "!" beside the project folder shows where everything goes on this PC; with nobody hired, the staff
    icons (artists too) hire one on a PC and software of your choice; **Advanced project setup** (was Start project)
    is a button beside Lets go!.
  - **Chats in projects:** a chat's head has **Project** (Default, or a project); its code Save starts in that
    project's folder; a project's Overview lists its chats.
  - **My local LLMs** (then "What's available on network"): shorter (an update says "Sent: …"; Send one of yours moved to the hot desk's Move
    window). The Staff window's left side takes at most a third.
- **2.0.36:** Projects and the Jobs window.
  - **Lets create a project** on Home: Project name, Project folder (the date and time unless typed; made inside the
    workspace folder), Mini description, Prompt, and Staff (Default, or one of the hires). **Lets go!** saves the
    project (its Scope card is written by code from those words) and the project manager plans it: the hire picked,
    or on Default the strongest worker available (most parameters, then most context). With nobody hired, **Setup
    staff** comes first. Start project (questions and the look) is a link under it. **Recent projects** replaces
    "Not started".
  - **Jobs:** a left column (All jobs, then the job's Overview, Step 1 to Step N, See all; a step opens alone). The
    Overview has the Scope card and the design brief (a copy icon, and a pencil that edits in place with Cancel and
    Save), Choose a Project manager, Roles (Coder, Writer, Auditing: assigned, not assigned or default) and what you
    expect of the final audit (given to the auditor with the end-of-job report). **LETS GO!!!**, at the foot, runs
    the rest of the steps. Each job keeps its own team, and its files go in its project folder.
  - Dropped: job rooms, "Who does the work" and "Big reading jobs" (each job's team took their place). A Windows
    notification about a job opens it in Jobs. Delete this job is in the Overview beside Hide.
- **2.0.35:** Smart Manager.exe waits as long as TOMLIN is starting (2.0.34 gave up after 90 seconds without a
  word, so a first start that was still backing up the data opened no window): after 90 seconds its icon says "Still
  starting" and the window opens when it is ready; it asks the page straight, never through a proxy set in Windows,
  and finds Edge by name if it is not in its usual folder. An update pushed from the main PC now brings a changed
  program too: an installed copy builds Smart Manager.exe again when `tools/tray.cs` changed (`src/trayfresh.ts`;
  `tray.sha256` beside it says which it was built from); the running one is renamed `Smart Manager.old.exe`, the new
  one is used from the next start. `runtime/node/LICENSE` is the full licence text of the Node.js that ships (fetched
  by `npm run fetch -- node`; `npm run pack` refuses without it). Stop on "Try each way" works again (since 2.0.28 it
  answered with a fault). `test/server.test.ts` starts the server itself on an empty home. The server's code is split
  by area into `src/server/` and `src/jobrun/` (what it does is unchanged; `src/server.ts` still starts it).
  From the base audit (`docs/AUDIT-2026-10-06-BASE-STABILITY.md`), all fixed in 2.0.35:
  - **Your data after a power cut:**
    - Every save is flushed to the disk before it takes the file's place.
    - A data file that cannot be read is set aside (`<name>.damaged-<time>`, beside it) and named on the page once,
      never read as empty and saved over.
    - A damaged PIN file keeps its lock shut; deleting it by hand is the way back.
  - **Import and restore:**
    - They replace nothing when the backup before them fails.
    - They swap folders by renames, so a stop part-way is finished or undone at the next start.
    - A backup is listed only when whole.
    - "Later" on the import question is not asked again once the home has chats or staff of its own.
  - **One copy per home** (`running.lock`): a second start on the same home stops before it touches anything.
  - **Linked PCs:**
    - A node lends only the models its owner ticked (also on the older "no model named" requests).
    - Linking again takes over the old link, and its restore points, only with proof of the old link's keys.
    - "Start it again" just after "I need to use the pc" loads the models back.
    - A pushed update waits for work that started during its check.
    - A pushed model never writes over a whole file.
    - A copy that is retried is sealed afresh.
  - **Two presses close together:**
    - Clear or Delete while an answer is written keeps the chat as it was left.
    - A second message waits for the first answer's save.
    - Drop then Connect never leaves a runner unseen.
    - Unload while a picture draws stays unloaded.
    - Loading another picture model is refused while one draws.
    - "Try each way" never cuts off a hire's answer.
    - Two Hugging Face downloads cannot start at once.
  - **Smaller fixes:**
    - The workspace can never be TOMLIN's own folders.
    - A day's log stops at 20 MB.
    - Open log works without Notepad.
    - A pushed update that never starts goes back to the copy before it (the tray and `Start TOMLIN.cmd`).
    - `npm run typecheck` runs a strict TypeScript check (`typescript` and `@types/node` are dev dependencies since
      2.0.49: `npm install` brings them; they stay out of the pack and out of updates).
- **Updates pushed to nodes (2.0.33):** a linked PC running an older TOMLIN shows **Outdated: 2.0.32 (this PC
  2.0.33)** on its tile (Nodes and memory > Other PCs > Linked) with **Update it**, or why not. On the node, tick
  **Allow host to update TOMLIN** (since 2.0.44 "... remotely"; the fourth tick; Allow all covers it). The host sends its app files (the same
  list the release zip holds, `src/update.ts` PARTS, which tools/pack.ts now reads too; no data, no models) over the encrypted link: the node compares hashes and asks only for the files that
  differ, copies the rest from its own copy, checks every file, puts the whole in `tomlin-<version>` beside its copy
  and ends with code 76; **Start TOMLIN.cmd** then starts the copy named in `next-copy.txt`, in the same window. The
  new version backs the data up on its first start, as every update does; the old copy stays for going back; "Start
  TOMLIN when this PC starts" is pointed at the new copy; the node's page says who updated it. Refused: not
  ticked, not newer, not started by Start TOMLIN.cmd, the owner pressed "I need to use the pc"; while the node works
  for someone (an answer, a picture) the host asks again every 10 s for up to 15 minutes. A node older than 2.0.33
  is updated by hand once (unzip); from then on from the host. Measured on one laptop: same code, a version step, 662
  bytes crossed and the node answered as the new version in about 15 s.
- **The Staff window** has two sides: **Your staff** on the left (with **Hire staff**, which opens its own window),
  and **Edit Staff** on the right. Edit (in Staff, the left panel's pencil, or Nodes and memory) opens that person on the Edit Staff side:
  photo, name, headline, Talk to, Mute and Fire, then About, Models, Role and level, Audition, Speed and Memory; a
  new hire with no model of their own opens there at once. On a phone the two sides stack. Changing the role
  between a chat role and a picture role asks first (the models of the other kind come off).
- **Default** is the first role and the first level in Hire staff. A Default hire is the model as it is, as a plain chat
  window would ask it: no instructions, no memory and the model's own sampling (only Qwen's thinking stays off, so a
  slow PC does not spend the whole answer thinking unseen). A Default level suggests no size and adds no "how you work"
  line. Receptionists hired before became Default (their name, chats and memory stay). Hire staff picks the model loaded
  now and puts its short name in the name box ("Qwen3.6-35B-A3B" becomes Qwen, a second one Qwen 2); a name typed by hand
  or from Random is kept. The short names come from the Hugging Face list (src/nicknames.ts).
- **Code to the drive:** every finished code block in an answer has **Save** in its corner: it suggests the file name
  from the line above the block (hires are asked to write one there), saves into the Files folder and says Replace when
  the file is there (the old one is kept as .bak). Hires are told this, so they no longer say they cannot save files.
  The chat's top row has **Save** (the whole chat as a text file, to Downloads) and **Copy** (the whole chat).
- **A chat with someone on another PC** shows that PC's CPU, GPU and RAM under the head, a snapshot every 3 s while the
  chat is on screen (that PC measures itself every second anyway; the snapshot reads its last figure).
- **Chats and pictures can be cleared:** each chat in the left panel has a bin: it asks, and whether its pictures go
  too. A chat's **…** window has **Empty this chat** (the messages go; the name, documents and pictures stay), asked on
  the page first. In an artist's chat, **Edit** puts a box on each picture (tick several, then **Delete**) and an × on
  each (the picture itself asks before it goes); **Delete today's** and **Delete all in this chat** are there too.
  Every delete asks on the page, in words, and is for good. A deleted picture shows as "Picture deleted." in its chat.
- **Home** opens from the logo (with the count of things to review beside it).
- **Answers keep running:** opening another chat (or starting one) leaves an answer running; coming back shows it
  carrying on, and **Working now** lists it. Chats on different models answer at the same time; a second chat on the
  same model waits for the first and says whose answer it waits for (it never stops it). **Stop** ends the open chat's
  own answer only; emptying or deleting a chat ends its answer. The blog writer refuses while a chat is answering on the connected model instead of stopping it.
- **Answers survive a refresh (2.0.31):** reloading or closing the page no longer stops an answer: it carries on in
  TOMLIN and is saved in the chat. Opening that chat again (or the reloaded page) picks the answer up where it
  is and follows it to the end; Stop still ends it. (Pictures are not followed this way: a picture still shows when it
  is finished.)
- **Memory in use** (top bar): RAM plus a graphics card's own memory. A chip with no memory of its own (Intel HD and
  the like) works from RAM the model already counts, so that share is said in the tooltip, not added again (measured
  5 Oct 2026 on the HD 520: Gemma 2 2B held 2.76 GB, which is what Windows lost; the old count added the 2.67 GB again, 5.4 GB).
- **Settings** and **Help** in the top bar open as pages, as Models does (not windows over the page); the left panel
  (or **‹ Chats and staff** on a phone) goes back. A **?** in a window opens Help at its part, and the window closes.
- **Models page:** Settings > Set up > **Add a model** opens a whole page. On its left: **Search
  filters** (**Min B** / **Max B**, **Min GB** / **Max GB**), then **Model categories** as tick boxes: **All models**
  (clears the ticks), **Chat models (LLMs)**, **Picture models**, **Helpers**, **Model runners** (any ticked shows),
  **Abliterated** and **Uncensored** (either word in the name narrows it); then **Import models**. On top: the search
  box (half the width), **Search**, and **All** | **Not installed** | **Installed**, which narrow every
  list, then **My local LLMs**. Every typed word must start a word in the model's name or notes; **all** lists every model and every chat
  model on Hugging Face.
- **Hugging Face list:** under the search, "File list from 5 Oct 2026." and **Rescan Hugging Face** (the count and time
  in its tooltip). A copy ships in `registry/hf-list.json.gz` (`npm run hf-list` before a bake makes a fresh one, or
  `npm run hf-list -- <data/hf-list.json>` ships a list already scanned), so a new PC searches it from the start. A scan reads Hugging Face's whole list of GGUF models, most downloaded first, down to those fewer than 10 people
  downloaded last month (about 190,000, 70 MB and a minute and a half on 5 Oct 2026), keeps the chat ones (or those
  with no task said) in `data/hf-list.json`, and searches read that copy: words, ticks (either-or) and the size in
  the name, with the count of matches. With no list at all (the shipped file missing), each search asks Hugging Face live. Each page then reads
  the sizes of its models from Hugging Face; when Hugging Face turns the PC away for asking too often (429), the page
  stops there and says so, and **Next** carries on from that model. Pages: **‹ Previous**, the page numbers reached so
  far, **Next ›**.
- **Model rows:** two lines per model and **See more** for the licence, the source and **Open on Hugging Face**. Each
  row shows its size before anything is pressed ("9B · Q4_K_M 5.3 GB - recommended · ✓ fits this PC"), and
  **Download 5.3 GB** takes the recommended size in one press; **Available in (22) sizes.** lists every size ("Qwen3.5
  9B Q4_K_M 5.3 GB - recommended"). The button turns into the download's progress with **Stop**, a card at the top of
  the page follows it too, and a stopped download carries on where it stopped. A search leaves out what cannot be used
  here: repos with no model file (only a read-me or a vision add-on), picture or speech models, and models behind a
  Hugging Face licence page. Every folder of a repo is read, so a big model whose sizes sit in folders of their own is
  found. Each file is checked against Hugging Face's SHA-256 before it is kept in `models/chat`.
- **Import models** ("Import from another folder"): two tiles. **Download**: any compatible gguf file from Hugging
  Face, moved into this copy's own chat-model folder (shown; folders inside it are read too, three deep). **Connect**:
  another manager's folder of LLM files, used where it is (Use this folder / Stop using it).
- **Profile photos, one per person:** open a picture and press **Set as profile photo**, then pick whose it is: the
  person of the open chat (listed first), you, or anyone else on the team. Each photo is a square copy kept in
  `data/faces/`, so deleting the picture or its chat does not take the photo away. Each person's photo shows in the
  chat list, the chat head, "+ New chat", the staff rows and beside their lines in the chat; yours beside your own
  lines. Letting someone go removes their photo. The one photo kept in a browser before 2.0.18 moves in once, as TOMLIN's.
- **With chat connected:** **Enhance prompt** (in an artist's chat) turns a short prompt into a detailed one, only
  when pressed. (`/image` in a chat and the **Want to see it?** offer under an answer were dropped in 2.0.28: the chat
  model's rewrite drifted from what was asked. Pictures are asked for in an artist's chat.)
- **App lock (optional):** the padlock in the top bar sets a PIN for the whole app (4 to 12 digits); once set, the
  padlock locks it at once. While it is locked, TOMLIN refuses every page and program call (only the lock
  screen answers), so another tab, browser or program on this PC cannot read the chats. A restart of TOMLIN or
  a browser closed and opened again also starts locked. **Settings** (top bar), **App lock**, can lock it by itself
  after some minutes with nothing done, change the PIN or turn it off. Work already running carries on, and linked
  PCs keep working. It locks the app, not the files on disk. Lost the PIN? Close TOMLIN, delete
  `app-lock.json` from `TOMLIN\data` in your user folder and start it again: the PIN is gone and the chats stay.
- **Gallery:** every picture, with how it was made. Open one to download it (or its original), draw it again with the
  same seed, re-run it at full quality, or copy the prompt.

## For other programs

TOMLIN listens on 127.0.0.1:8740 only.

| Endpoint | What it does |
|---|---|
| `GET /api/status` | Hardware, both panes (state, model, device, memory), the current picture job |
| `GET /api/models` | Chat and picture models, whether each fits, the model runners |
| `POST /api/models/{id}/load` | Body `{ "device": "auto" \| "gpu" \| "cpu", "threads": 0 }`; the id is URL-encoded |
| `POST /api/models/{id}/unload` | Ends that model's process |
| `POST /v1/chat/completions` | OpenAI-style chat with the connected chat model (streaming works) |
| `POST /v1/images/generations` | OpenAI-style: `{ "prompt", "n", "size": "600x600", "response_format": "b64_json" \| "url" }` |
| `GET /v1/models` | The loaded models |

Nothing loads by itself: with no model connected, these answer 409 and say so.
With the app lock on, the `/v1` endpoints answer 423 while it is locked; they work while the app is open in a browser, and
the `/api` endpoints need that browser's own unlock.

## Speed (measured 3 Oct 2026)

| Machine | Chat (Qwen 3.5 2B) | Picture, 512×512, 4 steps (SD 1.5 + LCM) |
|---|---|---|
| Dell Latitude E7470, i7-6600U (2 cores), 16 GB, Intel HD 520 | CPU: reads 18 tokens/s, writes 7–8 tokens/s | HD 520 (Vulkan): about 55 s. CPU only: about 3 minutes (42 s a step) |

The 30-second target for a CPU-only picture is not reached on this laptop. A desktop CPU with more cores, or a
graphics card, is needed for that.

## Tests

`npm test`. `test/filter.test.ts` is a release blocker: picture prompts that sexualise anyone under 18, or real
people, are refused.

Two tests start real PCs on this one (`test/pcs.ts` starts each copy on 127.0.0.1 with a home of its own in the
temp folder, and moves every place a copy could write there): `test/doors.test.ts` links a host and a node with the
setup code and tries the node's front door (a web page, an unknown or unsealed link, sizes per door), then project
backups through it (the round, with `TOMLIN_PROJECT_ROUND_SECONDS=3` instead of 10 minutes; "I need to use the pc";
Back up now; brought back). `test/oldnode.test.ts` takes 2.0.44 (the last version before the TOMLIN name) out of git
history and pushes Update it to it from a copy of this one: it must refuse the new launcher name, take the copy as
`Start Shelby.cmd`, end with 76 and come back as this version with the same build. It is skipped where there is no git
history. Together they add about two minutes to `npm test`.
