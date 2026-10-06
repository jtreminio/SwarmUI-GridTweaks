using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Backends;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.Diagnostics;
using System.IO;
using static SwarmUI.Builtin_GridGeneratorExtension.GridGeneratorExtension;

namespace GridTweaks;

public partial class GridTweaksExtension
{
    internal static string SimilarityExtensionFolder;
    private static readonly SemaphoreSlim SimilarityQueue = new(1, 1);
    /// <summary>Legacy cache/setup identity retained because LPIPS weights and preprocessing are unchanged.</summary>
    internal const string SimilarityMethod = "lpips-alex-v0.1-rgb512-ssim11-v1";
    private static bool SimilarityReady => SimilarityExtensionFolder is not null
        && File.Exists(Path.Combine(SimilarityExtensionFolder, ".cache", "similarity", SimilarityMethod + ".ready"));

    private static string SimilarityFolder(Session session, RunningGridDocument doc)
        => Path.Combine(SimilarityExtensionFolder, ".cache", "similarity", RunningGridDocument.Hash(session.User.UserID), doc.Id);

    private static string SettingsIdentity(T2IParamInput input, RunningGridDocument doc)
    {
        JObject settings = input.ToJSON();
        foreach (string key in doc.Axes[0].Values.SelectMany(v => v.Params.Keys).Append(doc.Axes[0].Mode))
        {
            settings.Remove(key);
        }
        return RunningGridDocument.Hash(new JObject(settings.Properties().OrderBy(p => p.Name, StringComparer.Ordinal)
            .Select(p => new JProperty(p.Name, p.Value.DeepClone()))).ToString(Formatting.None));
    }

    internal static List<string> SimilarityRows(RunningGridDocument doc)
    {
        List<string> rows = [""];
        foreach (RunningGridAxis axis in doc.Axes.Skip(1))
        {
            rows = rows.SelectMany(row => axis.Values.Where(v => !v.Skip)
                .Select(v => row.Length == 0 ? RunningGridDocument.Segment(v) : $"{row}/{RunningGridDocument.Segment(v)}")).ToList();
        }
        return rows;
    }

    internal static JObject SimilarityManifest(RunningGridDocument doc, string folder)
    {
        List<string> rows = SimilarityRows(doc);
        JArray columns = new(doc.Axes[0].Values.Where(v => !v.Skip).Select(v => new JObject
        {
            ["key"] = RunningGridDocument.Segment(v), ["title"] = v.Title
        }));
        long pairCount = (long)columns.Count * (columns.Count - 1) / 2 * rows.Count;
        if (pairCount > 1000000)
        {
            throw new SwarmUserErrorException("Similarity supports up to 1,000,000 row comparisons per gallery. Split this gallery into smaller comparisons.");
        }
        JArray cells = [];
        foreach (JObject column in columns)
        {
            foreach (string row in rows)
            {
                string stem = row.Length == 0 ? (string)column["key"] : $"{column["key"]}/{row}";
                if (!doc.Completed.TryGetValue(stem, out string extension)
                    || !new[] { "png", "jpg", "jpeg", "webp", "bmp" }.Contains(extension.ToLowerInvariant()))
                {
                    continue;
                }
                cells.Add(new JObject
                {
                    ["column"] = column["key"], ["row"] = row, ["stem"] = stem,
                    ["path"] = Path.GetFullPath(Path.Combine(folder, $"{stem}.{extension}")),
                    ["settings"] = doc.CellSettings.GetValueOrDefault(stem),
                    ["version"] = doc.CellVersions.GetValueOrDefault(stem, "")
                });
            }
        }
        return new JObject { ["method"] = SimilarityMethod, ["columns"] = columns, ["rows"] = new JArray(rows), ["cells"] = cells };
    }

    [API.APIDescription("Analyzes saved images using GPU-accelerated LPIPS when available, with CPU fallback, configures automatic refresh, installs extension-local scoring dependencies, or republishes the viewer with existing scores. Does not generate images or change saved column order.", "{started: bool, success: true}")]
    public static Task<JObject> RunningGridSimilarity(Session session,
        [API.APIParameter("Server-created gallery ID.")] string id,
        [API.APIParameter("analyze, setup (install dependencies and analyze), configure (only change automatic refresh), or refresh (republish the page using existing scores).")] string action = "analyze",
        [API.APIParameter("Refresh scores after future successful generation runs.")] bool automatic = true) => Respond(() =>
    {
        GalleryGate gate = Gate(session, id);
        lock (gate)
        {
            RequireIdle(gate);
            RunningGridDocument doc = Load(session, id);
            if (action == "refresh")
            {
                Publish(session, doc, BuildGrid(session, doc));
                return new JObject { ["started"] = false, ["success"] = true };
            }
            if (action != "analyze" && action != "setup" && action != "configure")
            {
                throw new SwarmUserErrorException("Unknown similarity action.");
            }
            if (action == "setup" && !session.User.HasPermission(Permissions.InstallFeatures))
            {
                throw new SwarmUserErrorException("Install Features permission is required for the one-time similarity setup.");
            }
            if (action != "configure")
            {
                if (!SimilarityReady && action != "setup")
                {
                    throw new SwarmUserErrorException("Set up similarity first to download its scoring weights.");
                }
                if (doc.Axes[0].Values.Count(v => !v.Skip) < 2 || doc.Completed.Count == 0)
                {
                    throw new SwarmUserErrorException("Generate images for at least two columns before analyzing similarity.");
                }
                SimilarityManifest(doc, Folder(session, doc)); // Reject oversized work before changing saved state.
            }
            doc.SimilarityEnabled = automatic;
            Save(session, doc);
            if (action != "configure")
            {
                StartSimilarity(session, doc, gate, action == "setup");
            }
            return new JObject { ["started"] = action != "configure", ["success"] = true };
        }
    });

    /// <summary>Starts while holding the gallery gate so mutations cannot race the job snapshot.</summary>
    private static void StartSimilarity(Session session, RunningGridDocument doc, GalleryGate gate, bool setup)
    {
        gate.SimilarityCancellation = CancellationTokenSource.CreateLinkedTokenSource(Program.GlobalProgramCancel);
        gate.SimilarityProgress = "Waiting to analyze similarity…";
        _ = Task.Run(() => ExecuteSimilarity(session, doc, gate, setup));
    }

    private static ProcessStartInfo SimilarityProcess()
    {
        ProcessStartInfo start = new() { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        string configured = Environment.GetEnvironmentVariable("RUNNING_GRID_PYTHON");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            start.FileName = configured;
        }
        else
        {
            ComfyUISelfStartBackend backend = Program.Backends.RunningBackendsOfType<ComfyUISelfStartBackend>().FirstOrDefault();
            if (backend is null)
            {
                throw new SwarmUserErrorException("Similarity needs a local ComfyUI Python runtime. Set RUNNING_GRID_PYTHON on the server to a Python executable with torch and torchvision if using a remote backend.");
            }
            NetworkBackendUtils.ConfigurePythonExeFor(backend.Settings.StartScript, "Running Grid similarity", start, out _, out string prefix);
            // Match core's backend device selection, including ROCm visibility and the ZLUDA launcher.
            start.Environment["CUDA_VISIBLE_DEVICES"] = backend.Settings.GPU_ID;
            start.Environment["ROCR_VISIBLE_DEVICES"] = backend.Settings.GPU_ID;
            if (OperatingSystem.IsWindows())
            {
                start.Environment["HIP_VISIBLE_DEVICES"] = backend.Settings.GPU_ID;
            }
            if (prefix.StartsWith("-- ", StringComparison.Ordinal))
            {
                start.ArgumentList.Add("--");
                start.ArgumentList.Add(prefix[3..]);
            }
        }
        start.ArgumentList.Add("-s");
        start.ArgumentList.Add(Path.Combine(SimilarityExtensionFolder, "Similarity", "worker.py"));
        return start;
    }

    private static async Task ExecuteSimilarity(Session session, RunningGridDocument doc, GalleryGate gate, bool setup)
    {
        CancellationToken token = gate.SimilarityCancellation.Token;
        bool acquired = false;
        try
        {
            await SimilarityQueue.WaitAsync(token);
            acquired = true;
            string folder = SimilarityFolder(session, doc);
            Directory.CreateDirectory(folder);
            WriteAtomic(Path.Combine(folder, "job.json"), SimilarityManifest(doc, Folder(session, doc)).ToString(Formatting.None));
            ProcessStartInfo start = SimilarityProcess();
            start.ArgumentList.Add(Path.Combine(folder, "job.json"));
            start.ArgumentList.Add(Path.Combine(SimilarityExtensionFolder, ".cache", "similarity"));
            if (setup)
            {
                start.ArgumentList.Add("--setup");
            }
            using Process process = Process.Start(start);
            using CancellationTokenRegistration cancel = token.Register(() =>
            {
                try { process.Kill(true); }
                catch (InvalidOperationException) { }
            });
            Task<string> errors = process.StandardError.ReadToEndAsync();
            while (await process.StandardOutput.ReadLineAsync() is string line)
            {
                if (line.StartsWith("RG_PROGRESS ", StringComparison.Ordinal))
                {
                    lock (gate)
                    {
                        gate.SimilarityProgress = line[12..];
                    }
                }
            }
            await process.WaitForExitAsync();
            string error = await errors;
            token.ThrowIfCancellationRequested();
            if (process.ExitCode != 0)
            {
                Logs.Error($"Running Grid similarity {doc.Id}: {error}");
                string readable = error.Split('\n').LastOrDefault(line => line.StartsWith("RG_ERROR ", StringComparison.Ordinal));
                throw new SwarmUserErrorException(readable is null ? "Similarity failed. See server log for details." : readable[9..]);
            }
            doc.SimilarityStatus = "Similarity updated";
        }
        catch (OperationCanceledException)
        {
            doc.SimilarityStatus = "Similarity stopped; previous scores kept";
        }
        catch (Exception ex)
        {
            doc.SimilarityStatus = (string)ExToError(ex)["error"];
            Logs.Error($"Running Grid similarity {doc.Id}: {ex.Message}");
        }
        finally
        {
            lock (gate)
            {
                gate.SimilarityCancellation.Dispose();
                gate.SimilarityCancellation = null;
                gate.SimilarityProgress = null;
                try
                {
                    Save(session, doc);
                    Publish(session, doc, BuildGrid(session, doc));
                }
                catch (Exception ex)
                {
                    Logs.Error($"Running Grid similarity {doc.Id} could not publish: {ex.Message}");
                }
            }
            if (acquired)
            {
                SimilarityQueue.Release();
            }
        }
    }

    internal static JObject CurrentSimilarity(RunningGridDocument doc, JObject result)
    {
        HashSet<string> columns = doc.Axes[0].Values.Where(v => !v.Skip).Select(RunningGridDocument.Segment).ToHashSet();
        HashSet<string> rows = SimilarityRows(doc).ToHashSet();
        JArray pairs = [];
        foreach (JObject pair in result["pairs"] as JArray ?? [])
        {
            string a = (string)pair["a"], b = (string)pair["b"];
            if (!columns.Contains(a) || !columns.Contains(b))
            {
                continue;
            }
            JObject current = (JObject)pair.DeepClone();
            current["rows"] = new JArray(((JArray)pair["rows"]).OfType<JObject>().Where(row =>
            {
                string key = (string)row["key"];
                string suffix = key.Length == 0 ? "" : $"/{key}";
                return rows.Contains(key) && doc.Completed.ContainsKey(a + suffix) && doc.Completed.ContainsKey(b + suffix)
                    && doc.CellVersions.GetValueOrDefault(a + suffix, "") == ((string)row["a_version"] ?? "")
                    && doc.CellVersions.GetValueOrDefault(b + suffix, "") == ((string)row["b_version"] ?? "");
            }).Select(row =>
            {
                JObject measurements = (JObject)row.DeepClone();
                measurements.Remove("ssim"); // Old results stay usable without publishing the retired metric.
                return measurements;
            }));
            pairs.Add(current);
        }
        return new JObject
        {
            ["method"] = result["method"], ["updated"] = result["updated"],
            ["expected_rows"] = rows.Count, ["pairs"] = pairs,
            ["columns"] = new JArray(doc.Axes[0].Values.Where(v => !v.Skip).Select(v => new JObject
            {
                ["key"] = RunningGridDocument.Segment(v), ["title"] = v.Title
            }))
        };
    }

    private static string PublishSimilarity(Session session, RunningGridDocument doc, string html)
    {
        if (SimilarityExtensionFolder is null)
        {
            return html;
        }
        string folder = Folder(session, doc);
        string resultPath = Path.Combine(SimilarityFolder(session, doc), "result.json");
        JObject result = new();
        try
        {
            if (File.Exists(resultPath))
            {
                result = JObject.Parse(File.ReadAllText(resultPath));
            }
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            // Optional scoring must not prevent generation or deletion from publishing its gallery.
            Logs.Error($"Running Grid {doc.Id} could not read cached similarity: {ex.Message}");
        }
        if ((string)result["method"] != SimilarityMethod)
        {
            result = new JObject();
        }
        result = CurrentSimilarity(doc, result);
        WriteAtomic(Path.Combine(folder, "similarity-data.js"), "window.runningGridSimilarityData = " + result.ToString(Formatting.None) + ";");
        foreach (string asset in new[] { "similarity-page.js", "similarity-page.css" })
        {
            File.Copy(Path.Combine(SimilarityExtensionFolder, "Assets", asset), Path.Combine(folder, asset), true);
        }
        string version = Guid.NewGuid().ToString("N");
        return html.Replace("</head>", $"<link rel=\"stylesheet\" href=\"similarity-page.css?v={version}\"></head>")
            .Replace("</body>", $"<script src=\"similarity-data.js?v={version}\"></script><script src=\"similarity-page.js?v={version}\"></script></body>");
    }
}
