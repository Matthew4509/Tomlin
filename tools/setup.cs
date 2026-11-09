// TOMLIN setup window (9 Nov 2026): the Windows face of tools/install.ts. "Install TOMLIN.cmd" builds this on the PC with
// the C# compiler that comes with Windows (.NET Framework 4), so nothing is downloaded, then runs it. It decides nothing
// itself: it asks "node tools/install.ts status" what is installed, checks a typed folder with "check", and runs
// "install --yes ..." with the answers, showing its lines. A copy of the same rules, so the console setup
// ("Install TOMLIN.cmd --console") and this window cannot drift apart.
//   TOMLIN Setup.exe --node <node.exe> --src <the unzipped folder> [--shots <folder>]
//   TOMLIN-Setup-<version>.exe   (no arguments: the release zip is carried after the exe's own bytes, tools/setupexe.ts;
//                                 it is checked against its SHA-256, unpacked to a temp folder, and removed again at the end)
// --shots saves a picture of each page and ends (how the pages are looked at without clicking through them).
// --extract <folder> (one-file exe only) unpacks and checks the zip without a window: exit 0 good, 3 damaged.
// Exit code: 0 done or closed, 1 the install failed, 9 the window could not start (the .cmd then uses the console).
// Written for the old C# 5 compiler (no string interpolation).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("TOMLIN Setup")]
[assembly: AssemblyProduct("TOMLIN")]
[assembly: AssemblyDescription("TOMLIN Setup")]

class Info
{
    public string Version = "", Installed = "", Root = "", Exe = "", Home = "", Vcrt = "ok", Rule = "no", Autostart = "no", User = "";
}

/** A read-only window of a file: the zip carried after the exe's own bytes (seekable, as ZipArchive needs). */
class SubStream : Stream
{
    readonly Stream inner; readonly long start, length; long pos;
    public SubStream(Stream s, long off, long len) { inner = s; start = off; length = len; }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return length; } }
    public override long Position { get { return pos; } set { pos = value; } }
    public override void Flush() { }
    public override int Read(byte[] buffer, int offset, int count)
    {
        long left = length - pos;
        if (left <= 0) return 0;
        inner.Seek(start + pos, SeekOrigin.Begin);
        int n = inner.Read(buffer, offset, (int)Math.Min((long)count, left));
        pos += n;
        return n;
    }
    public override long Seek(long offset, SeekOrigin origin)
    {
        pos = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? pos + offset : length + offset;
        return pos;
    }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}

/** "Preparing setup": shown while the exe unpacks itself. */
class Splash : Form
{
    Label l;
    public Splash()
    {
        Text = "TOMLIN setup";
        ClientSize = new Size(420, 110);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false; ControlBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9f);
        l = new Label(); l.Text = "Preparing setup ..."; l.AutoSize = false; l.SetBounds(20, 20, 380, 24); Controls.Add(l);
        ProgressBar b = new ProgressBar(); b.Style = ProgressBarStyle.Marquee; b.MarqueeAnimationSpeed = 30; b.SetBounds(20, 56, 380, 18); Controls.Add(b);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
    }
    volatile bool done;
    public void Say(string s) { try { if (IsHandleCreated) BeginInvoke(new Action(delegate { l.Text = s; })); } catch (Exception) { } }
    public void Finish() { done = true; try { if (IsHandleCreated) BeginInvoke(new Action(delegate { Close(); })); } catch (Exception) { } }
    protected override void OnShown(EventArgs e) { base.OnShown(e); if (done) Close(); }
}

class Wizard : Form
{
    static string node, src;
    Info info = new Info();
    string mode = "install"; // install, update or repair
    string chosenRoot = "";

    Panel header, footer;
    Label title, subtitle;
    Button back, next, cancel;
    List<Panel> pages = new List<Panel>();
    List<string> names = new List<string>();
    int at;
    Panel pWelcome, pFolder, pOptions, pProgress, pFinish;
    TextBox folderBox, log;
    CheckBox cDesktop, cAutostart, cFirewall, cVcrt, cLaunch;
    ProgressBar bar;
    Label finishText, welcomeText, optionsNote;
    bool running, failed;
    string lastLines = "";

    static Font F(float size, FontStyle st) { return new Font("Segoe UI", size, st); }

    [STAThread]
    static int Main(string[] args)
    {
        string shots = null, extractTo = null;
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--node") node = args[i + 1];
            if (args[i] == "--src") src = args[i + 1].TrimEnd('\\');
            if (args[i] == "--shots") shots = args[i + 1];
            if (args[i] == "--extract") extractTo = args[i + 1];
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // One file: this exe carries the release zip after its own bytes (tools/setupexe.ts). It is unpacked to a temp
        // folder first, and that folder is removed when setup closes.
        string temp = null;
        long off, len; string hash;
        if (string.IsNullOrEmpty(src) && FindPayload(out off, out len, out hash))
        {
            if (extractTo != null)
            {
                // A test hook: unpack, check, say so by the exit code.
                try { Unpack(off, len, hash, extractTo, delegate(string s) { }); return 0; } catch (Exception) { return 3; }
            }
            temp = Path.Combine(Path.GetTempPath(), "TS" + (Process.GetCurrentProcess().Id % 100000));
            string error = null, top = null;
            Splash sp = new Splash();
            Thread worker = new Thread(delegate()
            {
                try { top = Unpack(off, len, hash, temp, delegate(string s) { sp.Say(s); }); }
                catch (Exception e) { error = e.Message; }
                sp.Finish();
            });
            worker.IsBackground = true;
            worker.Start();
            sp.ShowDialog();
            if (error != null || top == null)
            {
                MessageBox.Show(error ?? "Setup could not unpack itself.", "TOMLIN setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                RemoveTemp(temp);
                return 1;
            }
            src = top;
            node = File.Exists(Path.Combine(src, "runtime\\node\\node.exe")) ? Path.Combine(src, "runtime\\node\\node.exe") : "node";
        }
        if (string.IsNullOrEmpty(node) || string.IsNullOrEmpty(src) || !File.Exists(Path.Combine(src, "tools\\install.ts"))) { RemoveTemp(temp); return 9; }
        Wizard w;
        try { w = new Wizard(); } catch (Exception) { RemoveTemp(temp); return 9; }
        if (shots != null) { w.Shots(shots); RemoveTemp(temp); return 0; }
        Application.Run(w);
        RemoveTemp(temp);
        return w.failed ? 1 : 0;
    }

    static void RemoveTemp(string dir)
    {
        if (string.IsNullOrEmpty(dir)) return;
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch (Exception) { }
    }

    const string Magic = "TOMLPAY1";

    /** The release zip after this exe's own bytes: [zip][64 hex of its SHA-256][zip length, 8 bytes][TOMLPAY1]. */
    static bool FindPayload(out long off, out long len, out string hash)
    {
        off = 0; len = 0; hash = null;
        try
        {
            using (FileStream fs = new FileStream(Application.ExecutablePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (fs.Length < 80) return false;
                byte[] t = new byte[80];
                fs.Seek(-80, SeekOrigin.End);
                int got = 0;
                while (got < 80) { int n = fs.Read(t, got, 80 - got); if (n <= 0) return false; got += n; }
                if (Encoding.ASCII.GetString(t, 72, 8) != Magic) return false;
                hash = Encoding.ASCII.GetString(t, 0, 64);
                len = BitConverter.ToInt64(t, 64);
                off = fs.Length - 80 - len;
                return off > 0 && len > 0;
            }
        }
        catch (Exception) { return false; }
    }

    static string Hex(byte[] b)
    {
        StringBuilder sb = new StringBuilder();
        foreach (byte x in b) sb.Append(x.ToString("x2"));
        return sb.ToString();
    }

    /** Checks the zip against its number, then unpacks it into dest. Returns the folder the zip holds (tomlin-<version>). */
    static string Unpack(long off, long len, string hash, string dest, Action<string> say)
    {
        using (FileStream fs = new FileStream(Application.ExecutablePath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            say("Checking the setup file ...");
            SubStream sub = new SubStream(fs, off, len);
            string got;
            using (System.Security.Cryptography.SHA256 sha = System.Security.Cryptography.SHA256.Create()) got = Hex(sha.ComputeHash(sub));
            if (!string.Equals(got, hash, StringComparison.OrdinalIgnoreCase)) throw new Exception("This setup file is damaged: its check number does not match. Download it again.");
            sub.Position = 0;
            Directory.CreateDirectory(dest);
            string full = Path.GetFullPath(dest).TrimEnd('\\') + "\\";
            string top = null;
            using (System.IO.Compression.ZipArchive z = new System.IO.Compression.ZipArchive(sub, System.IO.Compression.ZipArchiveMode.Read))
            {
                int n = 0, total = z.Entries.Count;
                foreach (System.IO.Compression.ZipArchiveEntry e in z.Entries)
                {
                    string name = e.FullName.Replace('/', '\\');
                    if (top == null) top = name.Split('\\')[0];
                    string target = Path.GetFullPath(Path.Combine(dest, name));
                    if (!target.StartsWith(full, StringComparison.OrdinalIgnoreCase)) throw new Exception("This setup file holds a path it should not (" + name + ").");
                    if (name.EndsWith("\\")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    System.IO.Compression.ZipFileExtensions.ExtractToFile(e, target, true);
                    if (++n % 100 == 0) say("Unpacking setup: " + (n * 100 / total) + "%");
                }
            }
            if (top == null) throw new Exception("This setup file is empty.");
            return Path.Combine(dest, top);
        }
    }

    /** Runs node tools/install.ts with the arguments; each output line goes to onLine; returns the exit code. */
    static int Node(string args, Action<string> onLine)
    {
        ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + Path.Combine(src, "tools\\install.ts") + "\" " + args);
        psi.WorkingDirectory = src;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        Process p = Process.Start(psi);
        DataReceivedEventHandler h = delegate(object s, DataReceivedEventArgs e) { if (e.Data != null && e.Data.Trim().Length > 0) onLine(e.Data.Trim()); };
        p.OutputDataReceived += h;
        p.ErrorDataReceived += h;
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        p.WaitForExit();
        p.WaitForExit(); // lets the last lines arrive
        return p.ExitCode;
    }

    static string Q(string path) { return "\"" + path.TrimEnd('\\') + "\""; }

    Info ReadStatus()
    {
        Info r = new Info();
        Node("status", delegate(string line)
        {
            int eq = line.IndexOf('=');
            if (eq < 1) return;
            string k = line.Substring(0, eq), v = line.Substring(eq + 1);
            if (k == "version") r.Version = v; else if (k == "installed") r.Installed = v; else if (k == "root") r.Root = v;
            else if (k == "exe") r.Exe = v; else if (k == "home") r.Home = v; else if (k == "vcrt") r.Vcrt = v;
            else if (k == "rule") r.Rule = v; else if (k == "autostart") r.Autostart = v; else if (k == "user") r.User = v;
        });
        if (r.Version.Length == 0) throw new Exception("no status");
        return r;
    }

    static bool Newer(string a, string b)
    {
        string[] x = a.Split('.'), y = b.Split('.');
        for (int i = 0; i < Math.Max(x.Length, y.Length); i++)
        {
            int p = 0, q = 0;
            if (i < x.Length) int.TryParse(x[i], out p);
            if (i < y.Length) int.TryParse(y[i], out q);
            if (p != q) return p > q;
        }
        return false;
    }

    Wizard()
    {
        info = ReadStatus();
        if (info.Installed.Length > 0) mode = Newer(info.Installed, info.Version) ? "repair" : "update";
        chosenRoot = info.Root;

        Text = "TOMLIN setup";
        ClientSize = new Size(600, 440);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        StartPosition = FormStartPosition.CenterScreen;
        Font = F(9f, FontStyle.Regular);
        BackColor = SystemColors.Control;
        try { Icon = new Icon(Path.Combine(src, "public\\icon.ico")); } catch (Exception) { }

        header = new Panel(); header.Dock = DockStyle.Top; header.Height = 70; header.BackColor = Color.White;
        title = new Label(); title.Font = F(13f, FontStyle.Bold); title.AutoSize = false; title.SetBounds(20, 12, 460, 28);
        subtitle = new Label(); subtitle.AutoSize = false; subtitle.SetBounds(20, 40, 460, 22); subtitle.ForeColor = Color.FromArgb(70, 70, 70);
        PictureBox logo = new PictureBox(); logo.SetBounds(530, 16, 40, 40); logo.SizeMode = PictureBoxSizeMode.StretchImage;
        try { logo.Image = Icon.ExtractAssociatedIcon(Path.Combine(src, "public\\icon.ico")).ToBitmap(); } catch (Exception) { }
        header.Controls.AddRange(new Control[] { title, subtitle, logo });
        Panel line1 = new Panel(); line1.Dock = DockStyle.Top; line1.Height = 1; line1.BackColor = Color.FromArgb(200, 200, 200);

        footer = new Panel(); footer.Dock = DockStyle.Bottom; footer.Height = 56;
        Panel line2 = new Panel(); line2.Dock = DockStyle.Top; line2.Height = 1; line2.BackColor = Color.FromArgb(200, 200, 200);
        back = new Button(); back.Text = "< Back"; back.SetBounds(335, 14, 80, 28);
        next = new Button(); next.Text = "Next >"; next.SetBounds(420, 14, 80, 28);
        cancel = new Button(); cancel.Text = "Cancel"; cancel.SetBounds(510, 14, 80, 28);
        back.Click += delegate { Go(at - 1); };
        next.Click += delegate { OnNext(); };
        cancel.Click += delegate { Close(); };
        AcceptButton = next;
        footer.Controls.AddRange(new Control[] { line2, back, next, cancel });

        BuildPages();
        // Docking order: the page area fills what is left.
        Panel area = new Panel(); area.Dock = DockStyle.Fill;
        foreach (Panel p in pages) { p.Dock = DockStyle.Fill; p.Visible = false; area.Controls.Add(p); }
        Controls.Add(area);
        Controls.Add(footer);
        Controls.Add(line1);
        Controls.Add(header);
        Go(0);
    }

    Label Text2(Panel p, string text, int x, int y, int w, int h)
    {
        Label l = new Label(); l.Text = text; l.AutoSize = false; l.SetBounds(x, y, w, h); p.Controls.Add(l); return l;
    }

    CheckBox Check(Panel p, string text, int y, bool on, int h)
    {
        CheckBox c = new CheckBox(); c.Text = text; c.Checked = on; c.AutoSize = false; c.SetBounds(26, y, 540, h); p.Controls.Add(c); return c;
    }

    void BuildPages()
    {
        string verb = mode == "install" ? "Install" : mode == "update" ? "Update" : "Repair";

        pWelcome = new Panel();
        welcomeText = Text2(pWelcome, "", 26, 22, 548, 250);
        pages.Add(pWelcome); names.Add("welcome");

        if (mode == "install")
        {
            pFolder = new Panel();
            Text2(pFolder, "TOMLIN will be installed in this folder. To use another, type its path or press Browse.", 26, 22, 548, 40);
            folderBox = new TextBox(); folderBox.Text = info.Root; folderBox.SetBounds(26, 70, 450, 24); pFolder.Controls.Add(folderBox);
            Button browse = new Button(); browse.Text = "Browse..."; browse.SetBounds(484, 68, 90, 28); pFolder.Controls.Add(browse);
            browse.Click += delegate
            {
                FolderBrowserDialog d = new FolderBrowserDialog();
                d.Description = "Pick the folder TOMLIN is installed in";
                d.ShowNewFolderButton = true;
                if (d.ShowDialog(this) == DialogResult.OK) folderBox.Text = d.SelectedPath.TrimEnd('\\').Length <= 3 ? Path.Combine(d.SelectedPath, "TOMLIN") : d.SelectedPath;
            };
            Text2(pFolder, "The folder must be new or empty. It is made for you if it does not exist. Your chats, staff, pictures and models are not kept here; they stay in " + info.Home + ".", 26, 112, 548, 60);
            Button reset = new Button(); reset.Text = "Use the standard folder"; reset.SetBounds(26, 182, 170, 28); pFolder.Controls.Add(reset);
            reset.Click += delegate { folderBox.Text = info.Root; };
            pages.Add(pFolder); names.Add("folder");
        }

        if (mode != "repair")
        {
            pOptions = new Panel();
            Text2(pOptions, "Choose what setup adds. You can change all of these later in TOMLIN.", 26, 18, 548, 24);
            cDesktop = Check(pOptions, "Put a TOMLIN shortcut on the desktop", 52, true, 24);
            cAutostart = Check(pOptions, "Start TOMLIN when I sign in to Windows (for a PC that lends its models to others)", 82, info.Autostart == "yes", 24);
            int y = 112;
            if (info.Rule == "no")
            {
                cFirewall = Check(pOptions, "This is a worker PC my other PCs will use: add the firewall rule (Windows asks you to allow it; only PCs on your home network get in)", y, true, 44);
                y += 54;
            }
            if (info.Vcrt != "ok")
            {
                cVcrt = Check(pOptions, info.Vcrt == "missing"
                    ? "Download the Microsoft Visual C++ Runtime (about 19 MB, from Microsoft). Without it TOMLIN opens but no model loads."
                    : "Update the Microsoft Visual C++ Runtime (about 19 MB, from Microsoft). The one on this PC is older than the model runners need.", y, true, 44);
                y += 54;
            }
            optionsNote = Text2(pOptions, "Nothing here needs an administrator account.", 26, y + 6, 548, 24);
            pages.Add(pOptions); names.Add("options");
        }

        pProgress = new Panel();
        bar = new ProgressBar(); bar.Style = ProgressBarStyle.Marquee; bar.MarqueeAnimationSpeed = 30; bar.SetBounds(26, 20, 548, 18); pProgress.Controls.Add(bar);
        log = new TextBox(); log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical; log.SetBounds(26, 50, 548, 220);
        log.BackColor = Color.White; log.Font = new Font("Consolas", 9f); log.TabStop = false; pProgress.Controls.Add(log);
        pages.Add(pProgress); names.Add("progress");

        pFinish = new Panel();
        finishText = Text2(pFinish, "", 26, 22, 548, 150);
        cLaunch = Check(pFinish, "Start TOMLIN now", 190, true, 24);
        pages.Add(pFinish); names.Add("finish");
    }

    void Go(int i)
    {
        at = Math.Max(0, Math.Min(pages.Count - 1, i));
        foreach (Panel p in pages) p.Visible = false;
        pages[at].Visible = true;
        string n = names[at];
        string verb = mode == "install" ? "Install" : mode == "update" ? "Update" : "Repair";
        back.Visible = n != "welcome" && n != "progress" && n != "finish";
        back.Enabled = at > 0;
        next.Enabled = true;
        cancel.Enabled = true;
        cancel.Text = "Cancel";
        string beforeRun = names[Math.Max(0, names.IndexOf("progress") - 1)];
        next.Text = n == beforeRun ? verb : n == "finish" ? "Finish" : "Next >";
        if (n == "welcome")
        {
            title.Text = "Welcome to TOMLIN setup";
            subtitle.Text = mode == "install" ? "Version " + info.Version : mode == "update" ? "Update " + info.Installed + " to " + info.Version : "Repair TOMLIN " + info.Installed;
            string who = info.User.Length > 0 ? "for " + info.User : "for you";
            if (mode == "install") welcomeText.Text = "This installs TOMLIN " + info.Version + " " + who + " only, with its own copy of Node.js. It needs no administrator account.\r\n\r\nYour chats, staff, pictures and models are kept in " + info.Home + " and are never touched by setup.\r\n\r\nClick Next to carry on.";
            else if (mode == "update") welcomeText.Text = "TOMLIN " + info.Installed + " is installed in " + info.Root + ". Setup replaces it with " + info.Version + " in the same folder, and keeps the version before it so you can go back.\r\n\r\nYour chats, staff, pictures and models are kept in " + info.Home + " and are never touched by setup.\r\n\r\nClick Next to carry on.";
            else welcomeText.Text = "TOMLIN " + info.Installed + " is installed in " + info.Root + ", which is newer than the " + info.Version + " in this setup, so it is not replaced.\r\n\r\nSetup can check the installed one and repair what is wrong (shortcuts, the program, a damaged copy). It stays " + info.Installed + ".\r\n\r\nClick Repair to carry on.";
            if (mode == "repair") next.Text = "Repair";
        }
        else if (n == "folder") { title.Text = "Where to install"; subtitle.Text = "TOMLIN goes in one folder, for you only."; }
        else if (n == "options") { title.Text = "Options"; subtitle.Text = "Shortcuts and start-up."; }
        else if (n == "progress")
        {
            title.Text = mode == "install" ? "Installing" : mode == "update" ? "Updating" : "Repairing";
            subtitle.Text = "Please wait; this takes a minute or two.";
            back.Visible = false; next.Enabled = false; cancel.Enabled = false;
        }
        else if (n == "finish")
        {
            back.Visible = false; cancel.Visible = false;
            if (failed)
            {
                title.Text = "Setup did not finish";
                subtitle.Text = "Nothing is lost: your chats and models were not touched.";
                finishText.Text = "Setup stopped. The last lines it showed:\r\n\r\n" + lastLines + "\r\n\r\nClose this window, fix the cause, then run Install TOMLIN again. Nothing was started.";
                cLaunch.Visible = false; next.Text = "Close";
            }
            else
            {
                title.Text = mode == "repair" ? "TOMLIN is repaired" : "TOMLIN is installed";
                subtitle.Text = "Version " + (mode == "repair" ? info.Installed : info.Version);
                finishText.Text = "TOMLIN is in " + info.Root + ".\r\n\r\nStart it from the Start menu (or the desktop shortcut). It runs by the clock: its icon there opens it again or quits it.\r\n\r\nYour chats, staff, pictures and models are in " + info.Home + ".";
                cLaunch.Visible = true;
            }
        }
        AcceptButton = next;
    }

    void OnNext()
    {
        string n = names[at];
        if (n == "finish")
        {
            if (!failed && cLaunch.Checked) LaunchApp();
            Close();
            return;
        }
        if (n == "folder")
        {
            string typed = folderBox.Text.Trim();
            string verdict = "";
            Node("check --dir " + Q(typed.Length == 0 ? info.Root : typed), delegate(string line) { if (verdict.Length == 0) verdict = line; });
            if (verdict != "ok")
            {
                MessageBox.Show(this, verdict.Length == 0 ? "That folder could not be checked." : verdict, "TOMLIN setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            chosenRoot = typed.Length == 0 ? info.Root : typed;
            info.Root = chosenRoot;
        }
        string beforeRun = names[Math.Max(0, names.IndexOf("progress") - 1)];
        if (n == beforeRun) { Go(names.IndexOf("progress")); StartRun(); return; }
        Go(at + 1);
    }

    void StartRun()
    {
        running = true;
        string args;
        if (mode == "repair") args = "repair --yes";
        else
        {
            args = "install --yes --no-start";
            if (mode == "install") args += " --dir " + Q(chosenRoot);
            args += cDesktop.Checked ? " --desktop" : " --no-desktop";
            args += cAutostart.Checked ? " --autostart" : " --no-autostart";
            args += cFirewall != null ? (cFirewall.Checked ? " --firewall" : " --no-firewall") : " --no-firewall";
            args += cVcrt != null ? (cVcrt.Checked ? " --vcrt" : " --no-vcrt") : " --no-vcrt";
        }
        Thread t = new Thread(delegate()
        {
            int code;
            List<string> keep = new List<string>();
            try
            {
                code = Node(args, delegate(string line)
                {
                    keep.Add(line);
                    if (keep.Count > 6) keep.RemoveAt(0);
                    BeginInvoke(new Action(delegate { log.AppendText(line + "\r\n"); }));
                });
            }
            catch (Exception e) { code = 1; keep.Add(e.Message); }
            BeginInvoke(new Action(delegate { Done(code, string.Join("\r\n", keep.ToArray())); }));
        });
        t.IsBackground = true;
        t.Start();
    }

    void Done(int code, string last)
    {
        running = false;
        failed = code != 0;
        lastLines = last;
        if (!failed) { try { Info now = ReadStatus(); info.Root = now.Root; info.Exe = now.Exe; } catch (Exception) { } }
        Go(names.IndexOf("finish"));
    }

    void LaunchApp()
    {
        try { if (File.Exists(info.Exe)) Process.Start(info.Exe); } catch (Exception) { }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (running) { e.Cancel = true; MessageBox.Show(this, "Setup is still working. Please wait for it to finish.", "TOMLIN setup", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
        base.OnFormClosing(e);
    }

    /** Saves a picture of each page into the folder (a test hook, see the top). */
    void Shots(string dir)
    {
        Directory.CreateDirectory(dir);
        Show();
        log.Text = "Copying TOMLIN 2.0.79 to the install folder ...\r\nbuild TOMLIN.exe\r\nadd TOMLIN to the Start menu";
        log.SelectionStart = log.Text.Length; log.SelectionLength = 0;
        lastLines = "The C# compiler that comes with Windows is not on this PC.";
        for (int i = 0; i < pages.Count; i++)
        {
            Go(i);
            Application.DoEvents();
            Bitmap bmp = new Bitmap(Width, Height);
            DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
            bmp.Save(Path.Combine(dir, (i + 1) + "-" + names[i] + ".png"), System.Drawing.Imaging.ImageFormat.Png);
        }
        failed = true;
        Go(names.IndexOf("finish"));
        Application.DoEvents();
        Bitmap bad = new Bitmap(Width, Height);
        DrawToBitmap(bad, new Rectangle(0, 0, Width, Height));
        bad.Save(Path.Combine(dir, "failed.png"), System.Drawing.Imaging.ImageFormat.Png);
        failed = false;
    }
}
