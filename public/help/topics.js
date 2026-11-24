// The map of Help: its groups (what a person wants to do), the topics in each, and where the old single-page
// Help's section names now live. Read by every page here (help.js), by the app (to open a topic) and by the test.
// A plain script: it sets one global, so it works from the app's own files with no server, no CDN and no build.
// After a change here, run: node tools/help-nav.ts (it rewrites each page's breadcrumbs and previous / next links).
'use strict';

globalThis.TOMLIN_HELP = {
  groups: [
    { id: 'start', title: 'Getting started', blurb: 'Put TOMLIN on a PC and find your way round.' },
    { id: 'models', title: 'Models', blurb: 'The software your staff think with: which to pick, where it comes from, what fits.' },
    { id: 'staff', title: 'Staff and chats', blurb: 'Hire people, talk to them, keep what they make, and what a chat may do.' },
    { id: 'network', title: 'Your network', blurb: 'Link other PCs, lend and borrow their models and memory, and who may do what.' },
    { id: 'backups', title: 'Backups, updates and data', blurb: 'Copies of your work, newer versions of TOMLIN, the app lock and the log.' },
    { id: 'work', title: 'Jobs, files and speed', blurb: 'Plans in steps, the queue, writing files and blog posts, and how fast and dear it is.' },
    { id: 'bridge', title: 'Projects and the Bridge', blurb: 'Your project folders, git, audits, live sites and backups to a drive.' },
    { id: 'look', title: 'Look and feel', blurb: 'Day, night and the other colours.' },
  ],
  topics: [
    { id: 'first-steps', group: 'start', title: 'First steps', blurb: 'One PC first: a model, a hire, a project. Then your other PCs.' },
    { id: 'installing', group: 'start', title: 'Installing TOMLIN', blurb: 'Unzip, Install TOMLIN.cmd, Repair install, start on start up.' },

    { id: 'models', group: 'models', title: 'Installing models', blurb: 'The Models page, what fits this PC, the model files you have and the runners.' },
    { id: 'model-picks', group: 'models', title: 'Which model to pick', blurb: 'Chat, picture and picture-to-text models, with sizes and measured speeds.' },
    { id: 'pictures', group: 'models', title: 'Getting a good picture', blurb: 'Draft, Mid or High, people, icons, cartoons and weak spots.' },

    { id: 'hiring', group: 'staff', title: 'Hiring staff', blurb: 'A specialist, a model and a PC tied together; roles, levels and looks.' },
    { id: 'saving', group: 'staff', title: 'Chats and saving your work', blurb: 'Projects, Save on code, the whole chat, subjects, scratch pad, snippets and Send to.' },
    { id: 'quick-think', group: 'staff', title: 'Quick or Think', blurb: 'Answer straight away, or work it out first.' },
    { id: 'web', group: 'staff', title: 'Web: searching and reading pages', blurb: 'The Web switch, the search engine, and the pace it reads at.' },
    { id: 'memory', group: 'staff', title: 'Memory', blurb: 'Lines a person keeps between chats, and the team memory.' },
    { id: 'tool-permissions', group: 'staff', title: 'Permissions: what a chat may do', blurb: 'Ask first or Auto for files and web, the coding, research and screen roles, standing rules.' },
    { id: 'office', group: 'staff', title: 'The office (Staff overview)', blurb: 'Your staff at their desks, the thoughts feed, the shop and the awards.' },
    { id: 'todo', group: 'staff', title: 'To Do', blurb: 'Today, This week and This month, My day and quick checks.' },

    { id: 'network-roles', group: 'network', title: 'Admin PC, node and storage', blurb: 'What each PC can be, and where models and backups are kept.' },
    { id: 'adding-pc', group: 'network', title: 'Adding a PC', blurb: 'Turn on the node, find it, type its setup code; the link helper when it will not link.' },
    { id: 'bootable-usb', group: 'network', title: 'Bootable USB', blurb: 'A USB stick that starts any PC as a linked node, the admin key, and best settings per kind of PC.' },
    { id: 'linked-pcs', group: 'network', title: 'Linked PCs', blurb: 'Using a node\'s models, two PCs on one node, what a linked PC card shows.' },
    { id: 'sharing-permissions', group: 'network', title: 'Sharing and cluster permissions', blurb: 'Each tick a node owner can give a linked host, and the host PIN.' },
    { id: 'guest-passes', group: 'network', title: 'Guest passes', blurb: 'Let another PC use chosen models, for a day, a week or no limit.' },
    { id: 'direct-links', group: 'network', title: 'Direct links between PCs', blurb: 'Two linked PCs copy a model straight to each other.' },
    { id: 'cluster', group: 'network', title: 'Max mode and Cluster', blurb: 'Borrow linked PCs to run a model too big for one, or to try to raise speed.' },
    { id: 'node-windows', group: 'network', title: 'Windows settings for a node', blurb: 'Hibernation, automatic sign-in, setup reminders, sleep and waking, start with the PC.' },
    { id: 'moving-staff', group: 'network', title: 'Moving staff to another PC', blurb: 'Drag a person to another desk; what fits, and what to do when the model is missing.' },

    { id: 'backups', group: 'backups', title: 'Backups and restore points', blurb: 'Projects and restore points on your other PCs; what is and is not backed up.' },
    { id: 'copying-models', group: 'backups', title: 'Copying models between PCs', blurb: 'Get a copy, send, move, and what a delete asks first.' },
    { id: 'updates', group: 'backups', title: 'Updates', blurb: 'Check for updates, update via zip, update linked PCs, the host PIN.' },
    { id: 'data-lock', group: 'backups', title: 'Data and lock', blurb: 'Where your data is, the app lock PIN, restore points and notifications.' },
    { id: 'trouble', group: 'backups', title: 'When something goes wrong', blurb: 'The log, and Report a problem.' },

    { id: 'jobs', group: 'work', title: 'Jobs', blurb: 'A goal turned into steps you read and change before anything runs.' },
    { id: 'queue', group: 'work', title: 'The queue', blurb: 'Work lined up so your PCs carry on without you.' },
    { id: 'files-blog', group: 'work', title: 'Files and the blog writer', blurb: 'Plain text files in your workspace folder, and posts drafted for you to edit.' },
    { id: 'speed', group: 'work', title: 'Speed', blurb: 'Tokens a second, Test speed and Find the fastest setup.' },
    { id: 'costs', group: 'work', title: 'Uptime and costs', blurb: 'How long a PC has run, tokens, power cost and what an API would charge.' },

    { id: 'bridge-projects', group: 'bridge', title: 'The Bridge: projects', blurb: 'Getting started, each project\'s buttons and menu, and the window around the list.' },
    { id: 'git', group: 'bridge', title: 'Git', blurb: 'Git marks, See what changed, and keeping Git itself up to date.' },
    { id: 'scanning', group: 'bridge', title: 'Scanning', blurb: 'Find PCs, rescan Hugging Face, scan folders, the audit and Hosted live.' },
    { id: 'bridge-pages', group: 'bridge', title: 'The Bridge: folders, audits and prompts', blurb: 'Working folders, the audit list and private details, saved prompts.' },
    { id: 'bridge-backups', group: 'bridge', title: 'The Bridge: backups', blurb: 'Zips to a drive, and copies on your other PCs.' },
    { id: 'bridge-trouble', group: 'bridge', title: 'The Bridge: privacy and trouble', blurb: 'What leaves this PC, if something goes wrong, and where its data is.' },

    { id: 'colours', group: 'look', title: 'Theme', blurb: 'Follow Windows, Day, Night or Auto; the Bridge\'s themes.' },
  ],
  // The old single page's section names, and where each is now: a link or a person's habit that uses one still lands.
  aliases: {
    'help-title': 'index.html', 'help-part-one': 'first-steps.html', 'help-part-two': 'network-roles.html', 'help-part-more': 'jobs.html',
    'help-models': 'models.html', 'help-chat': 'model-picks.html#help-chat', 'help-images': 'model-picks.html#help-images', 'help-vision': 'model-picks.html#help-vision',
    'help-tips': 'pictures.html', 'help-staff': 'hiring.html', 'help-todo': 'todo.html', 'help-office': 'office.html', 'help-saving': 'saving.html',
    'help-nodes': 'adding-pc.html', 'help-move': 'moving-staff.html', 'help-backups': 'backups.html', 'help-copies': 'copying-models.html',
    'help-git': 'git.html', 'help-scan': 'scanning.html', 'help-jobs': 'jobs.html', 'help-queue': 'queue.html', 'help-think': 'quick-think.html',
    'help-web': 'web.html', 'help-max': 'cluster.html', 'help-notebooks': 'memory.html', 'help-speed': 'speed.html', 'help-pc-costs': 'costs.html',
    'help-install': 'installing.html', 'help-pins': 'data-lock.html', 'help-log': 'trouble.html',
  },
};
