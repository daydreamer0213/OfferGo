using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OfferGoLauncher
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new StartupForm());
        }
    }

    internal sealed class StartupForm : Form
    {
        private readonly Label statusLabel;
        private readonly ProgressBar progress;
        private readonly Button diagnosticsButton;
        private readonly Timer timer;
        private readonly string installRoot;
        private readonly string progressPath;
        private readonly string diagnosticsPath;
        private Process process;
        private DateTime startedAt;
        private DateTime? readyAt;

        internal StartupForm()
        {
            installRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string iconPath = Path.Combine(installRoot, "assets", "OfferGo.ico");
            string progressRoot = Path.Combine(Path.GetTempPath(), "OfferGo");
            Directory.CreateDirectory(progressRoot);
            progressPath = Path.Combine(progressRoot, "startup-" + Guid.NewGuid().ToString("N") + ".json");
            diagnosticsPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RoleFlow", "Data", ".runtime", "logs");

            Text = "OfferGo 正在启动";
            ClientSize = new Size(460, 210);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            BackColor = Color.FromArgb(247, 250, 249);
            Font = new Font("Microsoft YaHei UI", 9F);
            if (File.Exists(iconPath)) Icon = new Icon(iconPath);

            PictureBox mark = new PictureBox();
            mark.Location = new Point(28, 27);
            mark.Size = new Size(52, 52);
            mark.SizeMode = PictureBoxSizeMode.Zoom;
            if (File.Exists(iconPath)) mark.Image = new Icon(iconPath, 48, 48).ToBitmap();

            Label title = new Label();
            title.AutoSize = true;
            title.Location = new Point(96, 27);
            title.Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold);
            title.Text = "OfferGo";

            Label hint = new Label();
            hint.AutoSize = true;
            hint.Location = new Point(98, 61);
            hint.ForeColor = Color.FromArgb(84, 104, 99);
            hint.Text = "工作台准备好后会自动打开";

            statusLabel = new Label();
            statusLabel.Location = new Point(29, 105);
            statusLabel.Size = new Size(400, 24);
            statusLabel.Text = "正在检查 OfferGo 运行环境…";

            progress = new ProgressBar();
            progress.Location = new Point(30, 137);
            progress.Size = new Size(400, 8);
            bool reducedMotion = SystemInformation.HighContrast || !SystemInformation.IsMenuAnimationEnabled;
            progress.Style = reducedMotion ? ProgressBarStyle.Blocks : ProgressBarStyle.Marquee;
            if (reducedMotion) progress.Value = 35;
            else progress.MarqueeAnimationSpeed = 28;

            diagnosticsButton = new Button();
            diagnosticsButton.Location = new Point(286, 163);
            diagnosticsButton.Size = new Size(144, 31);
            diagnosticsButton.Text = "打开诊断信息";
            diagnosticsButton.Visible = false;
            diagnosticsButton.Click += delegate { OpenDiagnostics(); };

            Controls.Add(mark);
            Controls.Add(title);
            Controls.Add(hint);
            Controls.Add(statusLabel);
            Controls.Add(progress);
            Controls.Add(diagnosticsButton);

            timer = new Timer();
            timer.Interval = 250;
            timer.Tick += delegate { Poll(); };
            Shown += delegate { StartOfferGo(); };
            FormClosed += delegate { Cleanup(); };
        }

        private void StartOfferGo()
        {
            try
            {
                string script = Path.Combine(installRoot, "scripts", "launch-installed.ps1");
                if (!File.Exists(script)) throw new FileNotFoundException("找不到 OfferGo 启动脚本。", script);
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "WindowsPowerShell", "v1.0", "powershell.exe");
                start.Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "
                    + Quote(script) + " -ProgressPath " + Quote(progressPath);
                start.WorkingDirectory = installRoot;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                process = Process.Start(start);
                startedAt = DateTime.UtcNow;
                timer.Start();
            }
            catch (Exception error)
            {
                ShowFailure(error.Message);
            }
        }

        private void Poll()
        {
            try
            {
                StartupProgress state = ReadProgress();
                if (state != null && !String.IsNullOrWhiteSpace(state.message)) statusLabel.Text = state.message;
                if (state != null && state.state == "ready")
                {
                    if (!readyAt.HasValue) readyAt = DateTime.UtcNow;
                    if ((DateTime.UtcNow - readyAt.Value).TotalMilliseconds >= 650) Close();
                    return;
                }
                if (state != null && state.state == "failed")
                {
                    ShowFailure(state.message);
                    return;
                }
                if (process != null && process.HasExited && process.ExitCode != 0)
                {
                    ShowFailure("OfferGo 启动失败，请打开诊断信息查看原因。");
                    return;
                }
                if ((DateTime.UtcNow - startedAt).TotalSeconds > 120)
                {
                    ShowFailure("OfferGo 启动时间过长，请打开诊断信息查看原因。");
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (Exception error) { ShowFailure(error.Message); }
        }

        private StartupProgress ReadProgress()
        {
            if (!File.Exists(progressPath)) return null;
            string json = File.ReadAllText(progressPath, Encoding.UTF8).TrimStart('\uFEFF');
            if (String.IsNullOrWhiteSpace(json)) return null;
            Dictionary<string, object> value = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            StartupProgress result = new StartupProgress();
            object state;
            object message;
            value.TryGetValue("state", out state);
            value.TryGetValue("message", out message);
            result.state = Convert.ToString(state);
            result.message = Convert.ToString(message);
            return result;
        }

        private void ShowFailure(string message)
        {
            timer.Stop();
            Text = "OfferGo 启动失败";
            statusLabel.Text = String.IsNullOrWhiteSpace(message) ? "OfferGo 暂时无法启动。" : message;
            statusLabel.ForeColor = Color.FromArgb(161, 51, 51);
            progress.Style = ProgressBarStyle.Blocks;
            progress.Value = 0;
            diagnosticsButton.Visible = true;
        }

        private void OpenDiagnostics()
        {
            try
            {
                Directory.CreateDirectory(diagnosticsPath);
                Process.Start(new ProcessStartInfo("explorer.exe", Quote(diagnosticsPath)) { UseShellExecute = true });
            }
            catch { }
        }

        private void Cleanup()
        {
            timer.Stop();
            try { if (File.Exists(progressPath)) File.Delete(progressPath); } catch { }
            if (process != null) process.Dispose();
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private sealed class StartupProgress
        {
            internal string state;
            internal string message;
        }
    }
}
