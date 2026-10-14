using Newtonsoft.Json.Linq;
using SwarmUI.Backends;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using System.Diagnostics;
using System.Reflection;
using Xunit;

namespace GridTweaks.Tests;

public partial class RunningGridTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SimilarityProcessCleansOnlyAutomaticPythonEnvironment(bool configured)
    {
        string[] keys = ["RUNNING_GRID_PYTHON", "PYTHONHOME", "CUDA_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES"];
        Dictionary<string, string> originalEnvironment = keys.ToDictionary(key => key, Environment.GetEnvironmentVariable);
        BackendHandler originalBackends = Program.Backends;
        try
        {
            string runtime = Path.Combine(temporary, "local comfy");
            string python = Path.GetFullPath(Path.Combine(runtime, "venv", OperatingSystem.IsWindows() ? "Scripts/python.exe" : "bin/python3"));
            Directory.CreateDirectory(Path.GetDirectoryName(python));
            File.WriteAllText(python, "fake executable; only process configuration is inspected");
            Program.Backends = new();
            Program.Backends.AllBackends[1] = new BackendHandler.BackendData
            {
                AbstractBackend = new ComfyUISelfStartBackend
                {
                    Status = BackendStatus.RUNNING,
                    SettingsRaw = new ComfyUISelfStartBackend.ComfyUISelfStartSettings { StartScript = Path.Combine(runtime, "main.py"), GPU_ID = "2" }
                }
            };
            Environment.SetEnvironmentVariable("RUNNING_GRID_PYTHON", configured ? "custom-python" : null);
            Environment.SetEnvironmentVariable("PYTHONHOME", "unrelated-python-home");
            foreach (string key in new[] { "CUDA_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES" })
            {
                Environment.SetEnvironmentVariable(key, "inherited-device");
            }

            ProcessStartInfo start = (ProcessStartInfo)typeof(GridTweaksExtension)
                .GetMethod("SimilarityProcess", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);

            Assert.Equal(configured ? "custom-python" : python, start.FileName);
            Assert.Equal(configured, start.Environment.ContainsKey("PYTHONHOME"));
            if (configured)
            {
                Assert.Equal("unrelated-python-home", start.Environment["PYTHONHOME"]);
            }
            Assert.Equal(configured ? "inherited-device" : "2", start.Environment["CUDA_VISIBLE_DEVICES"]);
            Assert.Equal(configured ? "inherited-device" : "2", start.Environment["ROCR_VISIBLE_DEVICES"]);
            Assert.Equal(configured || !OperatingSystem.IsWindows() ? "inherited-device" : "2", start.Environment["HIP_VISIBLE_DEVICES"]);
            Assert.Equal(new[] { "-s", Path.Combine(GridTweaksExtension.SimilarityExtensionFolder, "Similarity", "worker.py") }, start.ArgumentList);
        }
        finally
        {
            foreach ((string key, string value) in originalEnvironment)
            {
                Environment.SetEnvironmentVariable(key, value);
            }
            Program.Backends = originalBackends;
        }
    }

    [Fact]
    public async Task SimilarityManifestMatchesFullRowsAndDoesNotPublishPrompts()
    {
        string id = await Capture();
        JObject state = await Run(id);
        RunningGridDocument doc = state["gallery"].ToObject<RunningGridDocument>();
        JObject manifest = GridTweaksExtension.SimilarityManifest(doc, temporary);
        Assert.Equal(12, ((JArray)manifest["rows"]).Count);
        Assert.Equal(24, ((JArray)manifest["cells"]).Count);
        Assert.DoesNotContain("a fixed prompt", manifest.ToString());
        Assert.Single(((JArray)manifest["cells"]).Select(c => (string)c["settings"]).Distinct());
        Assert.Equal(24, ((JArray)manifest["cells"]).Select(c => (string)c["version"]).Distinct().Count());
        doc.Axes.Add(new RunningGridAxis { Mode = "steps", Values = [new() { Id = "one" }, new() { Id = "two", Skip = true }] });
        Assert.All(GridTweaksExtension.SimilarityRows(doc), row => Assert.EndsWith("/vone_initial", row));
        Assert.Equal(12, GridTweaksExtension.SimilarityRows(doc).Count);
    }

    [Fact]
    public async Task SimilarityProvenanceDistinguishesOneOffLoraFromBaseline()
    {
        string id = await Capture();
        RunningGridDocument before = (await Run(id))["gallery"].ToObject<RunningGridDocument>();
        RunningGridValue removed = before.Axes[0].Values[1];
        await GridTweaksExtension.RunningGridMembership(session, id, [removed.Id]);
        await GridTweaksExtension.RunningGridAppend(session, id, removed.Title);
        JObject run = await GridTweaksExtension.RunningGridRun(session, id, new JObject
        {
            ["overrides"] = new JObject { ["loras"] = new JArray("text-fusion.safetensors"), ["loraweights"] = "0.75" }
        });
        Assert.Null(run["error"]);
        RunningGridDocument after = (await WaitForCompletion(id))["gallery"].ToObject<RunningGridDocument>();
        Assert.Equal(2, after.CellSettings.Values.Distinct().Count());
        Assert.Equal(12, after.CellSettings.Values.Count(value => value == before.CellSettings.Values.First()));
        Assert.Null(after.BaseParams["loras"]);
    }

    [Fact]
    public async Task PublishedScoresDiscardDeletedAndRegeneratedCells()
    {
        string id = await Capture();
        RunningGridDocument doc = (await Run(id))["gallery"].ToObject<RunningGridDocument>();
        JObject result = FixtureScores(doc);
        Assert.Equal(12, ((JArray)GridTweaksExtension.CurrentSimilarity(doc, result)["pairs"][0]["rows"]).Count);
        string stem = doc.Completed.Keys.First();
        doc.CellVersions[stem] = "replacement-generation";
        Assert.Equal(11, ((JArray)GridTweaksExtension.CurrentSimilarity(doc, result)["pairs"][0]["rows"]).Count);
        doc.Axes[0].Values.RemoveAt(0);
        Assert.Empty((JArray)GridTweaksExtension.CurrentSimilarity(doc, result)["pairs"]);
    }

    [Fact]
    public async Task PublishedSimilarityKeepsLegacyLpipsAndDropsSsim()
    {
        string id = await Capture();
        RunningGridDocument doc = (await Run(id))["gallery"].ToObject<RunningGridDocument>();
        JObject legacy = FixtureScores(doc);
        legacy["method"] = "lpips-alex-v0.1-rgb512-ssim11-v1";
        foreach (JObject row in legacy["pairs"][0]["rows"])
        {
            row["ssim"] = .99;
        }
        JObject published = GridTweaksExtension.CurrentSimilarity(doc, legacy);
        Assert.Equal(12, published["pairs"][0]["rows"].Count());
        Assert.All(published["pairs"][0]["rows"].OfType<JObject>(), row =>
        {
            Assert.Null(row["ssim"]);
            Assert.Equal(.01, (double)row["lpips"]);
            Assert.Equal("same", (string)row["settings"]);
        });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RefreshGalleryPageKeepsImagesScoresAndAutomaticAnalysisPreference(bool automatic)
    {
        string id = await Capture();
        await Run(id);
        Assert.Null((await GridTweaksExtension.RunningGridSimilarity(session, id, "configure", automatic))["error"]);
        JObject state = await Read(id);
        RunningGridDocument doc = state["gallery"].ToObject<RunningGridDocument>();
        Assert.Equal(automatic, doc.SimilarityEnabled);
        string folder = Path.GetDirectoryName(Path.Combine(temporary, ((string)state["summary"]["url"])["Output/".Length..]));
        string cache = Path.Combine(GridTweaksExtension.SimilarityExtensionFolder, ".cache", "similarity", RunningGridDocument.Hash(session.User.UserID), id);
        Directory.CreateDirectory(cache);
        string scores = FixtureScores(doc).ToString();
        File.WriteAllText(Path.Combine(cache, "result.json"), scores);
        File.WriteAllText(Path.Combine(folder, "similarity-page.js"), "old viewer");
        Dictionary<string, string> images = doc.Completed.ToDictionary(cell => cell.Key, cell => File.ReadAllText(Path.Combine(folder, $"{cell.Key}.{cell.Value}")));

        JObject refreshed = await GridTweaksExtension.RunningGridSimilarity(session, id, "refresh");

        Assert.True((bool)refreshed["success"]);
        Assert.False((bool)refreshed["started"]);
        Assert.Equal(24, generated.Count);
        Assert.True(JToken.DeepEquals(state["gallery"], (await Read(id))["gallery"]));
        Assert.Equal(scores, File.ReadAllText(Path.Combine(cache, "result.json")));
        Assert.Contains("RunningGridSimilarityPage", File.ReadAllText(Path.Combine(folder, "similarity-page.js")));
        Assert.Contains("0.01", File.ReadAllText(Path.Combine(folder, "similarity-data.js")));
        Assert.All(doc.Completed, cell => Assert.Equal(images[cell.Key], File.ReadAllText(Path.Combine(folder, $"{cell.Key}.{cell.Value}"))));
    }

    [Fact]
    public async Task SimilaritySetupRequiresInstallPermissionAndRejectsInvalidActions()
    {
        string id = await Capture();
        Assert.Contains("Unknown", (string)(await GridTweaksExtension.RunningGridSimilarity(session, id, "bad"))["error"]);
        session.User.CalculatedRole.Data.PermissionFlags.Clear();
        session.User.CalculatedRole.Data.PermissionFlags.Add("gridgen_save_grids");
        Assert.Contains("Install Features", (string)(await GridTweaksExtension.RunningGridSimilarity(session, id, "setup"))["error"]);
    }

    [Fact]
    [Trait("Category", "BrowserFixture")]
    public async Task SimilarityWorkerPublishesPortablePageAndAutoRefreshesWithoutGenerationChanges()
    {
        string previous = Environment.GetEnvironmentVariable("RUNNING_GRID_PYTHON");
        try
        {
            PrepareSimilarityWorker(false);
            AddModel("krea2/shared-prefix-third.safetensors");
            AddModel("krea2/shared-prefix-fourth.safetensors");
            string id = await Capture();
            await Run(id);
            JObject start = await GridTweaksExtension.RunningGridSimilarity(session, id);
            Assert.True((bool)start["started"]);
            JObject state = await WaitForSimilarity(id);
            Assert.Equal("Similarity updated", (string)state["summary"]["similarity_status"]);
            Assert.True((bool)state["summary"]["similarity_enabled"]);
            Assert.Equal(48, generated.Count);
            string resultPath = Path.Combine(GridTweaksExtension.SimilarityExtensionFolder, ".cache", "similarity", RunningGridDocument.Hash(session.User.UserID), id, "result.json");
            Assert.Contains("2026-10-05T12:00:01Z", File.ReadAllText(resultPath));
            await Run(id);
            await WaitForSimilarity(id);
            Assert.Contains("2026-10-05T12:00:02Z", File.ReadAllText(resultPath));
            Assert.Equal(48, generated.Count);
            string folder = Path.Combine(session.User.OutputDirectory, ((string)state["summary"]["url"])["Output/".Length..].Replace("/index.html", ""));
            Assert.Contains("similarity-page.js", File.ReadAllText(Path.Combine(folder, "index.html")));
            Assert.Contains("window.runningGridSimilarityData", File.ReadAllText(Path.Combine(folder, "similarity-data.js")));
            string fixture = Path.Combine(AppContext.BaseDirectory, "SimilarityViewer");
            Directory.CreateDirectory(fixture);
            foreach (string path in Directory.GetFiles(folder))
            {
                File.Copy(path, Path.Combine(fixture, Path.GetFileName(path)), true);
            }
        }
        finally
        {
            Environment.SetEnvironmentVariable("RUNNING_GRID_PYTHON", previous);
        }
    }

    [Fact]
    public async Task SimilarityCancellationKeepsImagesAndBlocksConcurrentMutations()
    {
        string previous = Environment.GetEnvironmentVariable("RUNNING_GRID_PYTHON");
        try
        {
            PrepareSimilarityWorker(true);
            string id = await Capture();
            JObject generatedState = await Run(id);
            string folder = Path.GetDirectoryName(Path.Combine(temporary, ((string)generatedState["summary"]["url"])["Output/".Length..]));
            Dictionary<string, string> images = ((JObject)generatedState["gallery"]["Completed"]).Properties()
                .ToDictionary(cell => Path.Combine(folder, $"{cell.Name}.{cell.Value}"), cell => File.ReadAllText(Path.Combine(folder, $"{cell.Name}.{cell.Value}")));
            await GridTweaksExtension.RunningGridSimilarity(session, id);
            for (int attempt = 0; attempt < 300 && (string)(await Read(id))["summary"]["similarity_status"] != "Test worker ready"; attempt++)
            {
                await Task.Delay(25);
            }
            Assert.Equal("Test worker ready", (string)(await Read(id))["summary"]["similarity_status"]);
            Assert.Contains("running", (string)(await GridTweaksExtension.RunningGridAppend(session, id, "krea2/shared-prefix-first.safetensors"))["error"]);
            Assert.Contains("running", (string)(await GridTweaksExtension.RunningGridRun(session, id))["error"]);
            Assert.Contains("running", (string)(await GridTweaksExtension.RunningGridDelete(session, id))["error"]);
            Assert.Contains("running", (string)(await GridTweaksExtension.RunningGridSimilarity(session, id, "refresh"))["error"]);
            await GridTweaksExtension.RunningGridCancel(session, id);
            JObject state = await WaitForSimilarity(id);
            Assert.Contains("stopped", (string)state["summary"]["similarity_status"]);
            Assert.Equal(24, (int)state["summary"]["completed"]);
            Assert.All(images, file => Assert.Equal(file.Value, File.ReadAllText(file.Key)));
        }
        finally
        {
            Environment.SetEnvironmentVariable("RUNNING_GRID_PYTHON", previous);
        }
    }

    private static JObject FixtureScores(RunningGridDocument doc)
    {
        string a = RunningGridDocument.Segment(doc.Axes[0].Values[0]), b = RunningGridDocument.Segment(doc.Axes[0].Values[1]);
        return new JObject
        {
            ["method"] = GridTweaksExtension.SimilarityMethod, ["updated"] = DateTimeOffset.UtcNow.ToString("O"),
            ["pairs"] = new JArray(new JObject
            {
                ["a"] = a, ["b"] = b,
                ["rows"] = new JArray(GridTweaksExtension.SimilarityRows(doc).Select(row => new JObject
                {
                    ["key"] = row, ["lpips"] = .01, ["settings"] = "same",
                    ["a_version"] = doc.CellVersions[$"{a}/{row}"], ["b_version"] = doc.CellVersions[$"{b}/{row}"]
                }))
            })
        };
    }

    private void PrepareSimilarityWorker(bool wait)
    {
        string root = GridTweaksExtension.SimilarityExtensionFolder;
        Directory.CreateDirectory(Path.Combine(root, "Similarity"));
        Directory.CreateDirectory(Path.Combine(root, ".cache", "similarity"));
        File.WriteAllText(Path.Combine(root, ".cache", "similarity", GridTweaksExtension.SimilarityMethod + ".ready"), "test");
        File.WriteAllText(Path.Combine(root, "Similarity", "worker.py"), """
            import json, pathlib, sys, time
            path = pathlib.Path(sys.argv[1])
            job = json.loads(path.read_text())
            print('RG_PROGRESS Test worker ready', flush=True)
            """ + (wait ? "\ntime.sleep(60)\n" : "\n") + """
            import itertools
            columns = [column['key'] for column in job['columns']]
            cells = {(c['column'], c['row']): c for c in job['cells']}
            pairs = []
            for i, j in itertools.combinations(range(len(columns)), 2):
                a, b = columns[i], columns[j]
                distance = .01 if i % 2 == j % 2 else .4
                rows = [{'key': row, 'lpips': distance, 'settings': 'same',
                         'a_version': cells[a, row]['version'], 'b_version': cells[b, row]['version']} for row in job['rows']]
                pairs.append({'a': a, 'b': b, 'rows': rows})
            count = pathlib.Path(path.parent / 'invocations.txt')
            invocation = int(count.read_text()) + 1 if count.exists() else 1
            count.write_text(str(invocation))
            result = {'method': job['method'], 'updated': f'2026-10-05T12:00:{invocation:02d}Z', 'pairs': pairs}
            (path.parent / 'result.json').write_text(json.dumps(result))
            """);
        Environment.SetEnvironmentVariable("RUNNING_GRID_PYTHON", OperatingSystem.IsWindows() ? "python" : "python3");
    }

    private async Task<JObject> WaitForSimilarity(string id)
    {
        for (int attempt = 0; attempt < 300; attempt++)
        {
            JObject state = await Read(id);
            if (!(bool)state["summary"]["similarity_running"])
            {
                return state;
            }
            await Task.Delay(25);
        }
        throw new TimeoutException("Similarity worker did not finish.");
    }
}
