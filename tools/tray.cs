// TOMLIN.exe (Smart Manager.exe in an install made before the TOMLIN name): the installed app's own program (2.0.34).
// The installer (tools/install.ts) builds it on the PC with
// the C# compiler that comes with Windows (.NET Framework 4), so nothing is downloaded and nothing needs signing. It
// sits in the install folder beside current.txt, which names the copy to run (tomlin-<version>; older copies shelby-<version>), and:
//  - starts that copy's TOMLIN with no console window (the bundled Node.js, else the one on the PATH), inside a
//    Windows job object, so closing this program also ends TOMLIN and every model runner it started;
//  - opens TOMLIN in its own window (Microsoft Edge app mode; the default browser when there is no Edge);
//  - shows an icon by the clock: double-click opens the window; the menu opens it, starts it again, opens the folder,
//    repairs the install (tools/install.ts repair, in a window), quits; a message saying it did not start repairs it
//    when clicked;
//  - finds TOMLIN already answering on its port (started from a folder with Start TOMLIN.cmd): opens that one
//    and ends, instead of starting a second copy that would stop at once;
//  - starts it again when it ends with 75 (an import or a restore), and starts the newer copy named in next-copy.txt
//    when it ends with 76 (an update pushed from a linked PC), writing current.txt so the next start runs it too;
//  - "--quiet": no window at the start (Start with Windows); "--uninstall": runs the uninstaller in a window;
//    "--repair": runs Repair install in a window.
// Written for the old C# 5 compiler (no string interpolation). Only the job object needs Windows calls.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// The name Windows shows for the program (Task Manager, notifications): the file keeps its old name (installs depend on it).
[assembly: AssemblyTitle("TOMLIN")]
[assembly: AssemblyProduct("TOMLIN")]
[assembly: AssemblyDescription("TOMLIN")]

static class TomlinTray
{
    static string installDir;
    static string copyDir;
    static int port = 8740;
    static Process child;
    static bool quitting;
    /** The copy that ran before an update pushed from a linked PC, until the new one has answered once (null after). */
    static string previousDir;
    static NotifyIcon icon;
    static Form host;
    static readonly Queue<string> lastLines = new Queue<string>();
    static IntPtr job = IntPtr.Zero;

    [STAThread]
    static int Main(string[] args)
    {
        installDir = Path.GetDirectoryName(Application.ExecutablePath);
        bool quiet = Array.IndexOf(args, "--quiet") >= 0;
        int p;
        if (int.TryParse(Environment.GetEnvironmentVariable("TOMLIN_PORT"), out p) && p > 0) port = p;

        copyDir = CurrentCopy();
        if (copyDir == null)
        {
            // A copy beside it can still repair the install (src/repair.ts): it points current.txt at a whole copy.
            copyDir = AnyCopy();
            if (copyDir == null)
            {
                MessageBox.Show("TOMLIN is not installed properly: current.txt in " + installDir + " does not name a copy, and no copy was found beside it. Run \"Install TOMLIN.cmd\" from a TOMLIN zip.", "TOMLIN", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            if (MessageBox.Show("TOMLIN is not installed properly: current.txt in " + installDir + " does not name a copy to run.\r\n\r\nRepair the install now? A window shows each step.", "TOMLIN", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes) RunRepair();
            return 1;
        }
        if (Array.IndexOf(args, "--uninstall") >= 0) return Uninstall();
        if (Array.IndexOf(args, "--repair") >= 0) { RunRepair(); return 0; }

        // One at a time: started again while it runs, it only opens the window.
        bool first;
        // The name stays as it was, so a program built before the TOMLIN name and this one never run at once.
        Mutex one = new Mutex(true, "Local\\SmartManagerTray", out first);
        if (!first)
        {
            if (!quiet) OpenWindow();
            return 0;
        }

        Application.EnableVisualStyles();
        host = new Form();
        host.ShowInTaskbar = false;
        host.WindowState = FormWindowState.Minimized;
        host.Load += delegate { host.Visible = false; };
        IntPtr unused = host.Handle;

        icon = new NotifyIcon();
        try { icon.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { icon.Icon = SystemIcons.Application; }
        icon.Text = "TOMLIN";
        ContextMenu menu = new ContextMenu();
        menu.MenuItems.Add("Open TOMLIN", delegate { OpenWindow(); });
        menu.MenuItems.Add("Start it again", delegate { Restart(); });
        menu.MenuItems.Add("Open the TOMLIN folder", delegate { OpenFolder(); });
        menu.MenuItems.Add("Repair install", delegate { RunRepair(); });
        menu.MenuItems.Add("-");
        menu.MenuItems.Add("Quit TOMLIN", delegate { Quit(); });
        icon.ContextMenu = menu;
        icon.DoubleClick += delegate { OpenWindow(); };
        // A message that says it did not start: clicking it repairs the install.
        icon.BalloonTipClicked += delegate { if (offerRepair) RunRepair(); };
        icon.Visible = true;

        job = MakeJob();
        openOnStart = !quiet;
        // Already running, started another way (Start TOMLIN.cmd in a folder): that one is opened, nothing is started.
        if (Answers()) AlreadyRunning();
        else Start(!quiet);
        Application.ApplicationExit += delegate { Stop(); icon.Visible = false; };
        Application.Run();
        GC.KeepAlive(one);
        return 0;
    }

    /** The copy current.txt names (a folder beside this program), or null. */
    static string CurrentCopy()
    {
        try
        {
            string name = File.ReadAllText(Path.Combine(installDir, "current.txt")).Trim();
            string dir = Path.IsPathRooted(name) ? name : Path.Combine(installDir, name);
            return File.Exists(Path.Combine(dir, "src", "server.ts")) ? dir : null;
        }
        catch { return null; }
    }

    static string NodeExe(string dir)
    {
        string bundled = Path.Combine(dir, "runtime", "node", "node.exe");
        return File.Exists(bundled) ? bundled : "node";
    }

    static void Start(bool openWhenReady)
    {
        lastLines.Clear();
        ProcessStartInfo si = new ProcessStartInfo(NodeExe(copyDir), "src\\server.ts");
        si.WorkingDirectory = copyDir;
        si.UseShellExecute = false;
        si.CreateNoWindow = true;
        si.RedirectStandardOutput = true;
        si.RedirectStandardError = true;
        si.EnvironmentVariables["TOMLIN_LOOP"] = "1";
        si.EnvironmentVariables["TOMLIN_TRAY"] = "1";
        si.EnvironmentVariables.Remove("TOMLIN_OPEN");
        // Gone back from a new copy that never started: this copy points "Start with Windows" at itself again.
        if (failedDir != null) si.EnvironmentVariables["TOMLIN_FAILED"] = failedDir;
        else si.EnvironmentVariables.Remove("TOMLIN_FAILED");
        failedDir = null;
        Process proc = new Process();
        proc.StartInfo = si;
        proc.EnableRaisingEvents = true;
        proc.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { Keep(e.Data); };
        proc.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { Keep(e.Data); };
        proc.Exited += delegate { host.BeginInvoke((MethodInvoker)delegate { Ended(proc); }); };
        try
        {
            proc.Start();
        }
        catch (Exception ex)
        {
            Say("TOMLIN could not start: " + ex.Message + ". Install Node.js 22.18 or newer, or run \"Install TOMLIN.cmd\" again.", true);
            return;
        }
        if (job != IntPtr.Zero) AssignProcessToJobObject(job, proc.Handle);
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        child = proc;
        icon.Text = "TOMLIN: starting";
        ThreadPool.QueueUserWorkItem(delegate
        {
            // As long as it is starting: the first start of a new version backs the data up first, which can take
            // minutes on a full home folder. Ended meanwhile, Ended() says why.
            bool up = WaitUntilAnswering(proc, delegate
            {
                host.BeginInvoke((MethodInvoker)delegate
                {
                    if (child != proc) return;
                    icon.Text = "TOMLIN: still starting";
                    icon.ShowBalloonTip(8000, "TOMLIN", "Still starting: the first start of a new version backs up your data first. " + (openWhenReady ? "Its window opens when it is ready." : "Double-click this icon to open it once it is ready."), ToolTipIcon.Info);
                });
            });
            host.BeginInvoke((MethodInvoker)delegate
            {
                if (child != proc || !up) return;
                // The new copy answered: the one before it is no longer needed to go back to.
                previousDir = null;
                icon.Text = "TOMLIN";
                if (openWhenReady) OpenWindow();
            });
        });
    }

    static void Keep(string line)
    {
        if (line == null) return;
        lock (lastLines)
        {
            lastLines.Enqueue(line);
            while (lastLines.Count > 40) lastLines.Dequeue();
        }
    }

    /** It ended: 75 starts it again, 76 starts the newer copy named in next-copy.txt, anything else is said. */
    static void Ended(Process proc)
    {
        if (proc != child) return;
        int code = proc.ExitCode;
        child = null;
        if (quitting) { Application.Exit(); return; }
        if (code == 75) { Start(false); return; }
        // 77: another TOMLIN runs for this Windows user (src/server/core.ts): that one is opened.
        if (code == 77 && Answers()) { AlreadyRunning(); return; }
        if (code == 76)
        {
            string next = null;
            try
            {
                string file = Path.Combine(copyDir, "next-copy.txt");
                next = File.ReadAllText(file).Trim();
                File.Delete(file);
            }
            catch { }
            if (next != null && File.Exists(Path.Combine(next, "src", "server.ts")))
            {
                previousDir = copyDir;
                copyDir = next;
                // The next start (Start with Windows, the Start menu) runs the new copy too.
                WriteCurrent(next);
                icon.ShowBalloonTip(5000, "TOMLIN", "Updated by a linked PC: starting the new version.", ToolTipIcon.Info);
                Start(false);
                return;
            }
            Say("TOMLIN was updated, but the new version's folder was not found. Run \"Install TOMLIN.cmd\" again.", true);
            return;
        }
        string tail;
        lock (lastLines) tail = string.Join("\r\n", lastLines.ToArray());
        try { File.WriteAllText(Path.Combine(installDir, "last-run.txt"), tail); } catch { }
        // A new copy (pushed from a linked PC) that ended before it ever answered: the copy before it runs again.
        if (previousDir != null && Directory.Exists(previousDir))
        {
            failedDir = copyDir;
            copyDir = previousDir;
            previousDir = null;
            try { WriteCurrent(copyDir); } catch { }
            icon.ShowBalloonTip(8000, "TOMLIN", "The new version did not start (its last lines are in last-run.txt). The version before it is starting again.", ToolTipIcon.Warning);
            Start(false);
            return;
        }
        icon.Text = "TOMLIN: stopped";
        Say("TOMLIN stopped (code " + code + "). Its last lines are in last-run.txt in " + installDir + ". Click here to repair the install, or use \"Start it again\" in this icon's menu.", true);
    }

    /** The last message said it did not start: clicking it runs Repair install. */
    static bool offerRepair;
    /** Started without --quiet: the window opens once TOMLIN answers. */
    static bool openOnStart;

    /**
     * TOMLIN already answers on its port, started another way: from a folder (Start TOMLIN.cmd), or by a Start
     * with Windows entry made from one. That one is opened, and this program ends after saying so: two copies on one
     * home are never run, and Repair install (in My PC) makes this program the one that starts it.
     */
    static void AlreadyRunning()
    {
        if (openOnStart) OpenWindow();
        icon.Text = "TOMLIN: already running";
        offerRepair = false;
        icon.ShowBalloonTip(12000, "TOMLIN", "TOMLIN is already running, started another way (Start TOMLIN.cmd in a folder, or an older Start with Windows entry), so that one is used. To make this program start it from now on: open My PC in TOMLIN and press Repair install.", ToolTipIcon.Info);
        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
        t.Interval = 15000;
        t.Tick += delegate { t.Stop(); Application.Exit(); };
        t.Start();
    }

    /** True when something answers on TOMLIN's port now (any answer: a locked page says 423). */
    static bool Answers()
    {
        try
        {
            HttpWebRequest r = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/");
            r.Timeout = 1500;
            r.Proxy = null;
            using (r.GetResponse()) return true;
        }
        catch (WebException ex) { return ex.Response != null; }
        catch { return false; }
    }

    /** The newest copy beside this program that can repair the install, or null. */
    static string AnyCopy()
    {
        string best = null;
        DateTime when = DateTime.MinValue;
        try
        {
            foreach (string d in Directory.GetDirectories(installDir, "*-*"))
            {
                string n = Path.GetFileName(d);
                if (!n.StartsWith("tomlin-") && !n.StartsWith("shelby-")) continue;
                if (!File.Exists(Path.Combine(d, "tools\\install.ts")) || !File.Exists(Path.Combine(d, "src\\server.ts"))) continue;
                DateTime t = Directory.GetLastWriteTime(d);
                if (t > when) { when = t; best = d; }
            }
        }
        catch { }
        return best;
    }

    /** Repair install (tools/install.ts repair, src/repair.ts) in a window of its own that shows each step. */
    static void RunRepair()
    {
        string script = Path.Combine(copyDir, "tools\\install.ts");
        if (!File.Exists(script))
        {
            MessageBox.Show("This copy of TOMLIN (" + copyDir + ") has no repair tool. Run \"Install TOMLIN.cmd\" from a TOMLIN zip.", "TOMLIN", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        ProcessStartInfo si = new ProcessStartInfo("cmd.exe", "/c \"\"" + NodeExe(copyDir) + "\" \"" + script + "\" repair & pause\"");
        si.UseShellExecute = true;
        si.WorkingDirectory = copyDir;
        try { Process.Start(si); } catch (Exception ex) { MessageBox.Show("Repair install could not start: " + ex.Message, "TOMLIN"); }
    }

    /** The copy that failed to start, passed to the one started instead (TOMLIN_FAILED), once. */
    static string failedDir;

    /**
     * Names the copy to run in current.txt: its folder name when it sits in the install folder, else its full path.
     * Written beside it and swapped in, so a power cut never leaves current.txt empty.
     */
    static void WriteCurrent(string dir)
    {
        string parent = Path.GetDirectoryName(Path.GetFullPath(dir).TrimEnd('\\'));
        string value = string.Equals(parent, installDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) ? Path.GetFileName(dir.TrimEnd('\\')) : dir;
        string file = Path.Combine(installDir, "current.txt");
        string tmp = file + ".new";
        File.WriteAllText(tmp, value);
        if (File.Exists(file)) File.Replace(tmp, file, null);
        else File.Move(tmp, file);
    }

    /** True once the copy answers on its port; false if it ended first. `slow` is called once after 90 seconds. */
    static bool WaitUntilAnswering(Process proc, MethodInvoker slow)
    {
        for (int i = 0; ; i++)
        {
            if (child != proc || proc.HasExited) return false;
            if (i == 180) slow();
            try
            {
                HttpWebRequest r = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/");
                r.Timeout = 1000;
                // Straight to this PC: a proxy set in Windows never sees it.
                r.Proxy = null;
                using (r.GetResponse()) return true;
            }
            catch (WebException ex)
            {
                // Any answer (a locked page says 423) means it is up.
                if (ex.Response != null) return true;
            }
            catch { }
            Thread.Sleep(500);
        }
    }

    static void OpenWindow()
    {
        string url = "http://127.0.0.1:" + port + "/";
        foreach (string root in new string[] { Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("LOCALAPPDATA") })
        {
            if (string.IsNullOrEmpty(root)) continue;
            string edge = Path.Combine(root, "Microsoft\\Edge\\Application\\msedge.exe");
            if (!File.Exists(edge)) continue;
            try { Process.Start(edge, "--app=" + url + " --window-size=1280,860"); return; } catch { }
        }
        // Edge somewhere else: Windows finds it by name (App Paths); else the default browser.
        try { Process.Start("msedge.exe", "--app=" + url + " --window-size=1280,860"); return; } catch { }
        try { Process.Start(url); } catch { }
    }

    static void OpenFolder()
    {
        // The same folder as src/keep.ts resolveHome: TOMLIN_HOME (or its old name), else around TOMLIN_DATA, else
        // "TOMLIN" in the user's folder, or "Smart Manager" when only that one holds data (set up before the TOMLIN name).
        string home = Environment.GetEnvironmentVariable("TOMLIN_HOME");
        if (string.IsNullOrEmpty(home)) home = Environment.GetEnvironmentVariable("SHELBY_HOME");
        string data = Environment.GetEnvironmentVariable("TOMLIN_DATA");
        if (string.IsNullOrEmpty(home) && !string.IsNullOrEmpty(data)) home = Path.GetDirectoryName(Path.GetFullPath(data));
        if (string.IsNullOrEmpty(home))
        {
            string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            home = Path.Combine(user, "TOMLIN");
            string old = Path.Combine(user, "Smart Manager");
            if (!Directory.Exists(Path.Combine(home, "data")) && Directory.Exists(Path.Combine(old, "data"))) home = old;
        }
        try { Process.Start("explorer.exe", "\"" + home + "\""); } catch { }
    }

    static void Restart()
    {
        if (child == null) { Start(false); return; }
        Process old = child;
        child = null;
        Kill(old);
        Start(false);
    }

    static void Quit()
    {
        quitting = true;
        if (child == null) { Application.Exit(); return; }
        Kill(child);
        Application.Exit();
    }

    static void Stop()
    {
        if (child != null) Kill(child);
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    }

    /** Ends TOMLIN and what it started (the model runners). */
    static void Kill(Process p)
    {
        try
        {
            Process k = Process.Start(new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false });
            k.WaitForExit(10000);
        }
        catch { }
    }

    static void Say(string text, bool problem)
    {
        offerRepair = problem;
        icon.ShowBalloonTip(10000, "TOMLIN", text, problem ? ToolTipIcon.Warning : ToolTipIcon.Info);
    }

    static int Uninstall()
    {
        string node = NodeExe(copyDir);
        // The uninstaller asks its questions in a window of its own, and runs from a copy of Node.js outside the install
        // folder, so it can remove the whole folder.
        string temp = Path.Combine(Path.GetTempPath(), "tomlin-uninstall");
        try
        {
            Directory.CreateDirectory(temp);
            if (node != "node") { File.Copy(node, Path.Combine(temp, "node.exe"), true); node = Path.Combine(temp, "node.exe"); }
        }
        catch { }
        string script = Path.Combine(copyDir, "tools", "install.ts");
        ProcessStartInfo si = new ProcessStartInfo("cmd.exe", "/c \"\"" + node + "\" \"" + script + "\" uninstall & pause\"");
        si.UseShellExecute = true;
        si.WorkingDirectory = temp;
        try { Process.Start(si); } catch (Exception ex) { MessageBox.Show(ex.Message, "TOMLIN"); return 1; }
        return 0;
    }

    // ---- The job object: closing this program ends TOMLIN and its model runners with it ----

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong A, B, C, D, E, F;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static IntPtr MakeJob()
    {
        IntPtr j = CreateJobObject(IntPtr.Zero, null);
        if (j == IntPtr.Zero) return IntPtr.Zero;
        ExtendedLimits info = new ExtendedLimits();
        info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(j, 9, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) { CloseHandle(j); return IntPtr.Zero; }
        return j;
    }
}
