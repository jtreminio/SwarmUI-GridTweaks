using LiteDB;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Builtin_GridGeneratorExtension;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using System.Runtime.CompilerServices;
using Xunit;
using static SwarmUI.Builtin_GridGeneratorExtension.GridGenCore;
using static SwarmUI.Builtin_GridGeneratorExtension.GridGeneratorExtension;

[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace GridTweaks.Tests;

public partial class RunningGridTests : IDisposable
{
    private readonly string temporary = Path.Combine(Path.GetTempPath(), $"running-grid-tests-{Guid.NewGuid():N}");
    private readonly LiteDatabase database = new(new MemoryStream());
    private readonly Session session;
    private readonly T2IModelHandler models;
    private readonly T2IModelHandler loras;
    private readonly List<JObject> generated = [];
    private bool stopAfterOne;

    public RunningGridTests()
    {
        Directory.CreateDirectory(temporary);
        Program.NoPersist = false;
        Program.ServerSettings.Paths.OutputPath = temporary;
        Program.ServerSettings.Paths.AppendUserNameToOutputPath = false;
        SessionHandler sessions = (SessionHandler)RuntimeHelpers.GetUninitializedObject(typeof(SessionHandler));
        sessions.DBLock = new();
        sessions.Roles = new();
        sessions.UserDatabase = database.GetCollection<User.DatabaseEntry>("users");
        sessions.GenericData = database.GetCollection<SessionHandler.GenericDataStore>("grids");
        sessions.T2IPresets = database.GetCollection<T2IPreset>("presets");
        User user = new(sessions, new User.DatabaseEntry { ID = "test-user" });
        user.CalculatedRole = new Role("test") { Data = new() { PermissionFlags = ["*"] } };
        Program.ServerSettings.Metadata.ImageMetadataIncludeModelHash = false;
        session = new Session { User = user };
        T2IParamTypes.Types.Clear();
        T2IParamTypes.RegisterDefaults();
        SwarmUI.WebAPI.ModelsAPI.ExtraModelProviders.Clear();
        SwarmUI.WebAPI.ModelsAPI.ExtraModelProviders["test"] = _ => [];
        Program.Backends = new SwarmUI.Backends.BackendHandler();
        GridGeneratorExtension core = new();
        core.OnPreInit();
        ASSETS_DIR = Path.Combine(AppContext.BaseDirectory, "GridAssets");
        GridTweaksExtension.SimilarityExtensionFolder = Path.Combine(temporary, "extension");
        Directory.CreateDirectory(Path.Combine(GridTweaksExtension.SimilarityExtensionFolder, "Assets"));
        foreach (string path in Directory.GetFiles(Path.Combine(AppContext.BaseDirectory, "SimilarityAssets")))
        {
            File.Copy(path, Path.Combine(GridTweaksExtension.SimilarityExtensionFolder, "Assets", Path.GetFileName(path)));
        }
        EXTRA_FOOTER = "";
        models = new T2IModelHandler { ModelType = "Stable-Diffusion" };
        Program.T2IModelSets["Stable-Diffusion"] = models;
        loras = new T2IModelHandler { ModelType = "LoRA" };
        Program.T2IModelSets["LoRA"] = loras;
        string loraPath = Path.Combine(temporary, "text-fusion.safetensors");
        File.WriteAllText(loraPath, "fake lora");
        loras.Models["text-fusion.safetensors"] = new T2IModel(loras, temporary, loraPath, "text-fusion.safetensors");
        AddModel("krea2/shared-prefix-first.safetensors");
        AddModel("krea2/shared-prefix-second.safetensors");
        GridRunnerPostDryHook = (runner, input, set) =>
        {
            SwarmUIGridData data = (SwarmUIGridData)runner.Grid.LocalData;
            generated.Add(input.ToJSON());
            string path = Path.Combine(runner.BasePath, $"{set.BaseFilepath}.{runner.Grid.Format}");
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, input.ToJSON().ToString());
            data.AddOutput(new JObject
            {
                ["image"] = $"/{runner.URLBase}/{set.BaseFilepath}.{runner.Grid.Format}",
                ["batch_index"] = runner.Iteration.ToString(), ["request_id"] = input.UserRequestId.ToString(),
                ["metadata"] = new JObject { ["sui_image_params"] = input.ToJSON() }.ToString()
            });
            if (stopAfterOne)
            {
                data.Claim.LocalClaimInterrupt.Cancel();
            }
            return Task.CompletedTask;
        };
    }

    private void AddModel(string name)
    {
        string path = Path.Combine(temporary, name);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, "fake model");
        models.Models[name] = new T2IModel(models, temporary, path, name);
    }

    private async Task<string> Capture(string mode = "model", string values = null, JObject extra = null)
    {
        JObject input = new() { ["prompt"] = "a fixed prompt", ["seed"] = "-1", ["width"] = 512, ["height"] = 512, ["steps"] = 20 };
        if (extra is not null)
        {
            input.Merge(extra);
        }
        JObject result = await GridTweaksExtension.RunningGridCreate(session, "Comparison <safe>", new JObject
        {
            ["baseParams"] = input,
            ["gridAxes"] = new JArray
            {
                new JObject { ["mode"] = mode, ["vals"] = values ?? string.Join(",", models.Models.Keys.Order()) },
                new JObject { ["mode"] = "seed", ["vals"] = "1282164169, 1282164170, .., 1282164180" }
            }
        });
        Assert.True(result["error"] is null, result.ToString());
        return (string)result["id"];
    }

    private async Task<JObject> Read(string id)
    {
        JObject result = await GridTweaksExtension.RunningGridGet(session, id);
        Assert.Null(result["error"]);
        return result;
    }

    private async Task<JObject> Run(string id)
    {
        JObject start = await GridTweaksExtension.RunningGridRun(session, id);
        Assert.Null(start["error"]);
        return await WaitForCompletion(id);
    }

    private async Task<JObject> WaitForCompletion(string id)
    {
        for (int attempt = 0; attempt < 200; attempt++)
        {
            JObject data = await Read(id);
            if (!(bool)data["summary"]["running"])
            {
                Assert.Null(data["summary"]["error"]?.Value<string>());
                return data;
            }
            await Task.Delay(25);
        }
        throw new TimeoutException("Fake generation did not complete.");
    }

    [Fact]
    public async Task NewModelAddsOnlyTwelveCellsAndKeepsSavedSeedsAndPrompt()
    {
        string id = await Capture();
        JObject original = await Read(id);
        JObject first = await Run(id);
        Assert.Equal(24, generated.Count);
        Assert.Equal(24, (int)first["summary"]["completed"]);
        await Run(id);
        Assert.Equal(24, generated.Count);
        AddModel("krea2/shared-prefix-third.safetensors");
        JObject appended = await GridTweaksExtension.RunningGridAppend(session, id, string.Join(",", models.Models.Keys.OrderDescending()));
        Assert.Equal(1, (int)appended["added"]);
        JObject next = await Run(id);
        Assert.Equal(36, generated.Count);
        Assert.All(generated, value => Assert.Equal("a fixed prompt", (string)value["prompt"]));
        Assert.Equal(12, generated.Skip(24).Select(v => (string)v["seed"]).Distinct().Count());
        Assert.True(JToken.DeepEquals(original["gallery"]["Axes"][1], next["gallery"]["Axes"][1]));
        Assert.True(JToken.DeepEquals(original["gallery"]["BaseParams"], next["gallery"]["BaseParams"]));
    }

    [Fact]
    public async Task OutputCursorDeliversImagesOnceAndResetsForANewRun()
    {
        string id = await Capture();
        await Run(id);
        JObject first = (JObject)(await GridTweaksExtension.RunningGridGet(session, id, true, true))["live"];
        Assert.Equal(24, first["outputs"].Count());
        Assert.Equal(24, (int)first["next_output"]);
        Assert.False((bool)first["has_more"]);
        Assert.All(first["outputs"], output =>
        {
            Assert.NotEmpty((string)output["image"]);
            Assert.NotEmpty((string)output["batch_index"]);
            Assert.NotEmpty((string)output["request_id"]);
            Assert.Contains("a fixed prompt", (string)output["metadata"]);
        });
        JObject repeated = await GridTweaksExtension.RunningGridGet(session, id, true, true, (string)first["run_id"], 24);
        Assert.Empty(repeated["live"]["outputs"]);
        Assert.Empty(repeated["live"]["progress"]);
        AddModel("krea2/new.safetensors");
        await GridTweaksExtension.RunningGridAppend(session, id, "krea2/new.safetensors");
        await Run(id);
        JObject next = await GridTweaksExtension.RunningGridGet(session, id, true, true, (string)first["run_id"], 24);
        Assert.NotEqual((string)first["run_id"], (string)next["live"]["run_id"]);
        Assert.Equal(12, next["live"]["outputs"].Count());
        Assert.Equal(12, (int)next["live"]["next_output"]);
    }

    [Fact]
    public async Task CompletedRunCanDeliverMultiplePagesWithoutDroppingImages()
    {
        string id = await Capture("cfgscale", "1,2,..,25");
        await Run(id);
        List<string> images = [];
        string runId = "";
        int cursor = 0;
        bool more;
        do
        {
            JObject data = await GridTweaksExtension.RunningGridGet(session, id, true, true, runId, cursor);
            Assert.False((bool)data["summary"]["running"]);
            JObject live = (JObject)data["live"];
            Assert.InRange(live["outputs"].Count(), 1, 128);
            images.AddRange(live["outputs"].Select(o => (string)o["image"]));
            runId = (string)live["run_id"];
            cursor = (int)live["next_output"];
            more = (bool)live["has_more"];
        }
        while (more);
        Assert.Equal(300, images.Count);
        Assert.Equal(300, images.Distinct().Count());
    }

    [Fact]
    public async Task LivePreviewsAreCoalescedAndRemovedWhenImagesFinish()
    {
        string id = await Capture("cfgscale", "4");
        TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        GridRunnerPostDryHook = (runner, input, set) =>
        {
            SwarmUIGridData data = (SwarmUIGridData)runner.Grid.LocalData;
            string index = runner.Iteration.ToString();
            Task work = Task.Run(async () =>
            {
                foreach (double percent in new[] { 0.1, 0.5 })
                {
                    data.AddOutput(new JObject
                    {
                        ["gen_progress"] = new JObject
                        {
                            ["batch_index"] = index, ["request_id"] = "test", ["current_percent"] = percent,
                            ["preview"] = "data:image/png;base64,preview"
                        }
                    });
                }
                await release.Task;
                string path = Path.Combine(runner.BasePath, $"{set.BaseFilepath}.{runner.Grid.Format}");
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllText(path, "test image");
                data.AddOutput(new JObject
                {
                    ["image"] = $"/{runner.URLBase}/{set.BaseFilepath}.{runner.Grid.Format}",
                    ["batch_index"] = index, ["request_id"] = "test"
                });
            });
            lock (data.UpdateLock)
            {
                data.Rendering.Add(work);
            }
            return work;
        };
        await GridTweaksExtension.RunningGridRun(session, id);
        try
        {
            JObject data = null;
            for (int attempt = 0; attempt < 100; attempt++)
            {
                data = await GridTweaksExtension.RunningGridGet(session, id, true, true);
                if (data["live"]["progress"].Count() == 12)
                {
                    break;
                }
                await Task.Delay(25);
            }
            Assert.Equal(12, data["live"]["progress"].Count());
            Assert.All(data["live"]["progress"], p => Assert.Equal(0.5, (double)p["gen_progress"]["current_percent"]));
            Assert.Empty(data["live"]["outputs"]);
        }
        finally
        {
            release.SetResult();
            await WaitForCompletion(id);
        }
        JObject finished = await GridTweaksExtension.RunningGridGet(session, id, true, true);
        Assert.Empty(finished["live"]["progress"]);
        Assert.Equal(12, finished["live"]["outputs"].Count());
    }

    [Fact]
    public async Task RemovalDeletesTheColumnAndReaddingItGeneratesOnlyItsCellsWithRunOverrides()
    {
        string id = await Capture();
        JObject data = await Run(id);
        string valueId = (string)data["gallery"]["Axes"][0]["Values"][0]["Id"];
        string name = (string)data["gallery"]["Axes"][0]["Values"][0]["Params"]["model"];
        JObject removed = await GridTweaksExtension.RunningGridMembership(session, id, [valueId], true);
        Assert.Null(removed["error"]);
        data = await Read(id);
        Assert.Equal(12, (int)data["summary"]["completed"]);
        Assert.Single(data["gallery"]["Axes"][0]["Values"]);
        Assert.DoesNotContain(data["gallery"]["Axes"][0]["Values"], value => (string)value["Id"] == valueId);
        Assert.DoesNotContain(Directory.EnumerateFiles(temporary, "*", SearchOption.AllDirectories), path => path.Contains($"v{valueId}_"));
        Assert.True(File.Exists(models.GetModel(name).RawFilePath));
        Assert.Empty((await GridTweaksExtension.RunningGridGet(session, id, true, true))["live"]["outputs"]);
        await Run(id);
        Assert.Equal(24, generated.Count);
        JObject append = await GridTweaksExtension.RunningGridAppend(session, id, string.Join(",", models.Models.Keys));
        Assert.Equal(1, (int)append["added"]);
        JObject start = await GridTweaksExtension.RunningGridRun(session, id, new JObject
        {
            ["overrides"] = new JObject { ["loras"] = new JArray("text-fusion"), ["loraweights"] = "0.75" }
        });
        Assert.Null(start["error"]);
        data = await WaitForCompletion(id);
        Assert.Equal(36, generated.Count);
        Assert.All(generated.Skip(24), input =>
        {
            Assert.Equal(name, models.GetModel((string)input["model"]).Name);
            Assert.Contains("text-fusion", input["loras"].ToString());
            Assert.Equal("a fixed prompt", (string)input["prompt"]);
        });
        Assert.Equal(24, (int)data["summary"]["completed"]);
        Assert.Null(data["gallery"]["BaseParams"]["loras"]);
        Assert.Equal(0, (int)(await GridTweaksExtension.RunningGridAppend(session, id, name))["added"]);
    }

    [Fact]
    public async Task LegacyRemovedEntriesDisappearOnLoadAndDoNotBlockReadding()
    {
        string id = await Capture();
        JObject original = await Run(id);
        JObject legacy = (JObject)original["gallery"].DeepClone();
        JToken removed = legacy["Axes"][0]["Values"][0];
        removed["Removed"] = true;
        string valueId = (string)removed["Id"], name = (string)removed["Params"]["model"];
        foreach (string path in Directory.EnumerateFiles(temporary, "*", SearchOption.AllDirectories).Where(path => path.Contains($"v{valueId}_")))
        {
            File.Delete(path);
        }
        session.User.SaveGenericData("running_grid_v1", id, legacy.ToString());
        JObject loaded = await Read(id);
        Assert.Single(loaded["gallery"]["Axes"][0]["Values"]);
        Assert.Equal(12, (int)loaded["summary"]["completed"]);
        Assert.Equal(12, (int)loaded["summary"]["cells"]);
        Assert.True(JToken.DeepEquals(original["gallery"]["BaseParams"], loaded["gallery"]["BaseParams"]));
        Assert.Equal(1, (int)(await GridTweaksExtension.RunningGridAppend(session, id, name))["added"]);
        JObject saved = JObject.Parse(session.User.GetGenericData("running_grid_v1", id));
        Assert.Equal(2, saved["Axes"][0]["Values"].Count());
        Assert.All(saved["Axes"][0]["Values"], value => Assert.Null(value["Removed"]));
        await Run(id);
        Assert.Equal(36, generated.Count);
    }

    [Fact]
    public async Task RemovingEveryColumnLeavesAnEmptyGalleryThatCanBeRepopulated()
    {
        string name = models.Models.Keys.First();
        string id = await Capture(values: name);
        JObject data = await Run(id);
        string valueId = (string)data["gallery"]["Axes"][0]["Values"][0]["Id"];
        Assert.Null((await GridTweaksExtension.RunningGridMembership(session, id, [valueId]))["error"]);
        data = await Read(id);
        Assert.Empty(data["gallery"]["Axes"][0]["Values"]);
        Assert.Equal(0, (int)data["summary"]["completed"]);
        Assert.Equal(0, (int)data["summary"]["cells"]);
        string page = Path.Combine(temporary, ((string)data["summary"]["url"])["Output/".Length..]);
        Assert.Contains("Add values", File.ReadAllText(page));
        Assert.NotNull((await GridTweaksExtension.RunningGridMembership(session, id, [valueId], false))["error"]);
        Assert.Equal(1, (int)(await GridTweaksExtension.RunningGridAppend(session, id, name))["added"]);
        await Run(id);
        Assert.Equal(24, generated.Count);
    }

    [Fact]
    public async Task MovingAColumnRepublishesOrderWithoutChangingImagesOrRegenerating()
    {
        string id = await Capture();
        JObject original = await Run(id);
        JArray values = (JArray)original["gallery"]["Axes"][0]["Values"];
        string first = (string)values[0]["Id"], second = (string)values[1]["Id"];
        string folder = Path.GetDirectoryName(Path.Combine(temporary, ((string)original["summary"]["url"])["Output/".Length..]));
        Dictionary<string, string> images = ((JObject)original["gallery"]["Completed"]).Properties()
            .ToDictionary(p => Path.Combine(folder, $"{p.Name}.{p.Value}"), p => File.ReadAllText(Path.Combine(folder, $"{p.Name}.{p.Value}")));
        session.User.CalculatedRole.Data.PermissionFlags = [PermSaveGrids.ID];
        JObject moved = await GridTweaksExtension.RunningGridMoveValue(session, id, second, first);
        Assert.Null(moved["error"]);
        Assert.True((bool)moved["moved"]);
        JObject reordered = await Read(id);
        Assert.Equal(new[] { second, first }, reordered["gallery"]["Axes"][0]["Values"].Select(v => (string)v["Id"]));
        Assert.True(JToken.DeepEquals(original["gallery"]["Completed"], reordered["gallery"]["Completed"]));
        Assert.True(JToken.DeepEquals(original["gallery"]["Axes"][1], reordered["gallery"]["Axes"][1]));
        Assert.True(JToken.DeepEquals(original["gallery"]["BaseParams"], reordered["gallery"]["BaseParams"]));
        Assert.Equal(24, generated.Count);
        foreach ((string path, string content) in images)
        {
            Assert.Equal(content, File.ReadAllText(path));
        }
        JObject published = JObject.Parse(File.ReadAllText(Path.Combine(folder, "data.js"))["rawData = ".Length..]);
        Assert.Equal(values.Reverse().Select(v => $"v{v["Id"]}_{v["Revision"]}"), published["axes"][0]["values"].Select(v => (string)v["path"]));
        session.User.CalculatedRole.Data.PermissionFlags = ["*"];
        await Run(id);
        Assert.Equal(24, generated.Count);
        JObject restored = await GridTweaksExtension.RunningGridMoveValue(session, id, second, first, true);
        Assert.True((bool)restored["moved"]);
        Assert.True(JToken.DeepEquals(original["gallery"]["Axes"], (await Read(id))["gallery"]["Axes"]));
    }

    [Fact]
    public async Task MovingColumnsAfterDeletionRejectsDeletedIdsAndReaddedValuesGoLast()
    {
        string id = await Capture("cfgscale", "4, 5, 6");
        JObject data = await Read(id);
        string[] ids = data["gallery"]["Axes"][0]["Values"].Select(v => (string)v["Id"]).ToArray();
        await GridTweaksExtension.RunningGridMembership(session, id, [ids[1]], true);
        JObject moved = await GridTweaksExtension.RunningGridMoveValue(session, id, ids[2], ids[0]);
        Assert.True((bool)moved["moved"]);
        JObject reordered = await Read(id);
        Assert.Equal(new[] { ids[2], ids[0] }, reordered["gallery"]["Axes"][0]["Values"].Select(v => (string)v["Id"]));
        Assert.False((bool)(await GridTweaksExtension.RunningGridMoveValue(session, id, ids[2], ids[0]))["moved"]);
        Assert.False((bool)(await GridTweaksExtension.RunningGridMoveValue(session, id, ids[0], ids[2], true))["moved"]);
        Assert.False((bool)(await GridTweaksExtension.RunningGridMoveValue(session, id, ids[0], ids[0]))["moved"]);
        Assert.NotNull((await GridTweaksExtension.RunningGridMoveValue(session, id, ids[1], ids[0]))["error"]);
        Assert.NotNull((await GridTweaksExtension.RunningGridMoveValue(session, id, "unknown", ids[0]))["error"]);
        Assert.NotNull((await GridTweaksExtension.RunningGridMoveValue(session, id, ids[0], ids[1]))["error"]);
        Assert.NotNull((await GridTweaksExtension.RunningGridMoveValue(session, id, ids[0], "unknown"))["error"]);
        Assert.True(JToken.DeepEquals(reordered["gallery"], (await Read(id))["gallery"]));
        await GridTweaksExtension.RunningGridAppend(session, id, "5");
        Assert.Equal(new[] { ids[2], ids[0], ids[1] }, (await Read(id))["gallery"]["Axes"][0]["Values"].Select(v => (string)v["Id"]));
    }

    [Fact]
    public async Task ADragMovesAcrossMultipleColumnsWithoutLosingIntermediateValues()
    {
        string id = await Capture("cfgscale", "2, 3, 4, 5, 6");
        JObject data = await Read(id);
        string[] ids = data["gallery"]["Axes"][0]["Values"].Select(v => (string)v["Id"]).ToArray();
        Assert.True((bool)(await GridTweaksExtension.RunningGridMoveValue(session, id, ids[0], ids[4], true))["moved"]);
        Assert.Equal(new[] { ids[1], ids[2], ids[3], ids[4], ids[0] }, (await Read(id))["gallery"]["Axes"][0]["Values"].Select(v => (string)v["Id"]));
        Assert.True((bool)(await GridTweaksExtension.RunningGridMoveValue(session, id, ids[4], ids[2]))["moved"]);
        Assert.Equal(new[] { ids[1], ids[4], ids[2], ids[3], ids[0] }, (await Read(id))["gallery"]["Axes"][0]["Values"].Select(v => (string)v["Id"]));
        Assert.Empty(generated);
    }

    [Fact]
    public async Task MovingAColumnIsBlockedWhileGenerationIsActive()
    {
        string id = await Capture();
        JObject original = await Read(id);
        string valueId = (string)original["gallery"]["Axes"][0]["Values"][1]["Id"];
        TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        GridRunnerPostDryHook = (runner, input, set) => release.Task;
        await GridTweaksExtension.RunningGridRun(session, id);
        try
        {
            string targetId = (string)original["gallery"]["Axes"][0]["Values"][0]["Id"];
            JObject result = await GridTweaksExtension.RunningGridMoveValue(session, id, valueId, targetId);
            Assert.Contains("running", (string)result["error"]);
            Assert.Contains("running", (string)(await GridTweaksExtension.RunningGridDelete(session, id))["error"]);
            Assert.True(JToken.DeepEquals(original["gallery"]["Axes"], (await Read(id))["gallery"]["Axes"]));
        }
        finally
        {
            release.SetResult();
            await WaitForCompletion(id);
        }
    }

    [Fact]
    public async Task InterruptedRunResumesOnlyUnfinishedCells()
    {
        string id = await Capture();
        stopAfterOne = true;
        JObject stopped = await Run(id);
        Assert.Single(generated);
        Assert.Equal(1, (int)stopped["summary"]["completed"]);
        stopAfterOne = false;
        await Run(id);
        Assert.Equal(24, generated.Count);
    }

    [Fact]
    public async Task ChangedModelRegeneratesOnlyItsOwnCells()
    {
        string id = await Capture();
        await Run(id);
        File.AppendAllText(models.Models.Values.First().RawFilePath, "changed");
        JObject result = await Run(id);
        Assert.Equal(36, generated.Count);
        Assert.Equal(24, (int)result["summary"]["completed"]);
    }

    [Fact]
    public async Task StopDuringPlanningDoesNotDiscardAlreadyCompletedCells()
    {
        string id = await Capture();
        await Run(id);
        await GridTweaksExtension.RunningGridRun(session, id);
        await GridTweaksExtension.RunningGridCancel(session, id);
        JObject stopped = await WaitForCompletion(id);
        Assert.Equal(24, (int)stopped["summary"]["completed"]);
        await Run(id);
        Assert.Equal(24, generated.Count);
    }

    [Fact]
    public async Task RandomSeedInputsAreLockedAndRepeatedAxisValuesArePreserved()
    {
        JObject result = await GridTweaksExtension.RunningGridCreate(session, "Random seed capture", new JObject
        {
            ["baseParams"] = new JObject { ["seed"] = -1, ["wildcardseed"] = -1, ["variationseed"] = -1 },
            ["gridAxes"] = new JArray
            {
                new JObject { ["mode"] = "cfgscale", ["vals"] = "4,7" },
                new JObject { ["mode"] = "seed", ["vals"] = "-1,-1" }
            }
        });
        Assert.True(result["error"] is null, result.ToString());
        JObject saved = await Read((string)result["id"]);
        foreach (string key in new[] { "seed", "variationseed", "wildcardseed" })
        {
            Assert.NotEqual("-1", (string)saved["gallery"]["BaseParams"][key]);
        }
        JArray seeds = (JArray)saved["gallery"]["Axes"][1]["Values"];
        Assert.Equal(2, seeds.Count);
        Assert.NotEqual((string)seeds[0]["Id"], (string)seeds[1]["Id"]);
        Assert.All(seeds, seed => Assert.NotEqual("-1", (string)seed["Params"]["seed"]));
    }

    [Fact]
    public async Task UninstalledCompletedModelDoesNotBlockNewModels()
    {
        string id = await Capture();
        await Run(id);
        string missing = models.Models.Keys.First();
        models.Models.TryRemove(missing, out _);
        AddModel("krea2/new.safetensors");
        JObject appended = await GridTweaksExtension.RunningGridAppend(session, id, "krea2/new.safetensors");
        Assert.Null(appended["error"]);
        JObject result = await Run(id);
        Assert.Equal(36, (int)result["summary"]["completed"]);
        Assert.Equal(36, generated.Count);
    }

    [Fact]
    public async Task GeneratedHtmlEscapesPromptLabelsAndDeletionRequiresPermission()
    {
        string id = await Capture("prompt", "plain || <img src=x onerror=alert(1)>");
        JObject data = await Run(id);
        string htmlPath = Path.Combine(temporary, ((string)data["summary"]["url"])["Output/".Length..]);
        string html = File.ReadAllText(htmlPath);
        Assert.DoesNotContain("<img src=x onerror=alert(1)>", html);
        Assert.Contains("&lt;img src=x onerror=alert(1)&gt;", html);
        session.User.CalculatedRole.Data.PermissionFlags = [PermSaveGrids.ID];
        string valueId = (string)data["gallery"]["Axes"][0]["Values"][0]["Id"];
        JObject result = await GridTweaksExtension.RunningGridMembership(session, id, [valueId], true);
        Assert.Contains("permission", ((string)result["error"]).ToLowerInvariant());
        Assert.Equal(24, (int)(await Read(id))["summary"]["completed"]);
    }

    [Fact]
    public async Task MissingSavedFileIsRegeneratedButOtherCellsAreKept()
    {
        string id = await Capture("cfgscale", "4, 7");
        JObject result = await Run(id);
        string stem = ((JObject)result["gallery"]["Completed"]).Properties().First().Name;
        string folder = Path.GetDirectoryName(Path.Combine(temporary, ((string)result["summary"]["url"])["Output/".Length..]));
        File.Delete(Path.Combine(folder, $"{stem}.{result["gallery"]["Format"]}"));
        await Run(id);
        Assert.Equal(25, generated.Count);
    }

    [Fact]
    public async Task OtherUserCannotReadOrModifyGallery()
    {
        string id = await Capture();
        User other = new(session.User.SessionHandlerSource, new User.DatabaseEntry { ID = "another-user" });
        other.CalculatedRole = session.User.CalculatedRole;
        JObject read = await GridTweaksExtension.RunningGridGet(new Session { User = other }, id);
        Assert.NotNull(read["error"]);
        JObject append = await GridTweaksExtension.RunningGridAppend(new Session { User = other }, id, "4");
        Assert.NotNull(append["error"]);
        string valueId = (string)(await Read(id))["gallery"]["Axes"][0]["Values"][0]["Id"];
        JObject move = await GridTweaksExtension.RunningGridMoveValue(new Session { User = other }, id, valueId, valueId);
        Assert.NotNull(move["error"]);
        JObject invalid = await GridTweaksExtension.RunningGridGet(session, "../../somewhere");
        Assert.NotNull(invalid["error"]);
    }

    [Fact]
    public async Task RunOverridesAffectOnlyNewCellsAndNeverPersistToTheBaseline()
    {
        T2IParamTypes.Register<string>(new("Magic Prompt Post Filter", "Test extension parameter", ""));
        string id = await Capture(extra: new JObject { ["magicpromptpostfilter"] = "original filter" });
        JObject original = await Run(id);
        string folder = Path.GetDirectoryName(Path.Combine(temporary, ((string)original["summary"]["url"])["Output/".Length..]));
        Dictionary<string, string> existing = ((JObject)original["gallery"]["Completed"]).Properties()
            .ToDictionary(p => Path.Combine(folder, $"{p.Name}.{p.Value}"), p => File.ReadAllText(Path.Combine(folder, $"{p.Name}.{p.Value}")));
        AddModel("krea2/new.safetensors");
        await GridTweaksExtension.RunningGridAppend(session, id, "krea2/new.safetensors");
        JObject overrides = new()
        {
            ["loras"] = new JArray("text-fusion"), ["loraweights"] = "0.75", ["loratencweights"] = "0.5",
            ["lorasectionconfinement"] = "0", ["steps"] = "30", ["magicpromptpostfilter"] = "one-off filter"
        };
        JObject started = await GridTweaksExtension.RunningGridRun(session, id, new JObject { ["overrides"] = overrides });
        Assert.Null(started["error"]);
        JObject completed = await WaitForCompletion(id);
        Assert.Equal(36, generated.Count);
        Assert.All(generated.Skip(24), value =>
        {
            Assert.Contains("text-fusion", value["loras"].ToString());
            Assert.Contains("0.75", value["loraweights"].ToString());
            Assert.Contains("0.5", value["loratencweights"].ToString());
            Assert.Equal("30", (string)value["steps"]);
            Assert.Equal("one-off filter", (string)value["magicpromptpostfilter"]);
            Assert.Equal("a fixed prompt", (string)value["prompt"]);
        });
        Assert.Equal(generated.Take(12).Select(value => (string)value["seed"]).Order(), generated.Skip(24).Select(value => (string)value["seed"]).Order());
        Assert.True(JToken.DeepEquals(original["gallery"]["BaseParams"], completed["gallery"]["BaseParams"]));
        foreach ((string path, string content) in existing)
        {
            Assert.Equal(content, File.ReadAllText(path));
        }
        JObject events = await GridTweaksExtension.RunningGridGet(session, id, true, true);
        Assert.All(events["live"]["outputs"], output => Assert.Contains("text-fusion", (string)output["metadata"]));
        await GridTweaksExtension.RunningGridRun(session, id, new JObject { ["overrides"] = new JObject { ["steps"] = 40 } });
        await WaitForCompletion(id);
        Assert.Equal(36, generated.Count);
        AddModel("krea2/later.safetensors");
        await GridTweaksExtension.RunningGridAppend(session, id, "krea2/later.safetensors");
        await Run(id);
        Assert.Equal(48, generated.Count);
        Assert.All(generated.Skip(36), value =>
        {
            Assert.Null(value["loras"]);
            Assert.Equal("20", (string)value["steps"]);
            Assert.Equal("original filter", (string)value["magicpromptpostfilter"]);
        });
    }

    [Fact]
    public async Task DisabledOverrideDoesNotRemoveSavedLorasAndRetriesUseSavedSettings()
    {
        string id = await Capture(extra: new JObject { ["loras"] = new JArray("text-fusion"), ["loraweights"] = "0.8" });
        JObject original = await Read(id);
        JObject started = await GridTweaksExtension.RunningGridRun(session, id, new JObject
        {
            ["overrides"] = new JObject { ["loras"] = null, ["loraweights"] = null, ["loratencweights"] = null, ["lorasectionconfinement"] = null }
        });
        Assert.Null(started["error"]);
        JObject completed = await WaitForCompletion(id);
        Assert.All(generated, value => Assert.Null(value["loras"]));
        Assert.True(JToken.DeepEquals(original["gallery"]["BaseParams"], completed["gallery"]["BaseParams"]));
        string folder = Path.GetDirectoryName(Path.Combine(temporary, ((string)completed["summary"]["url"])["Output/".Length..]));
        JProperty cell = ((JObject)completed["gallery"]["Completed"]).Properties().First();
        File.Delete(Path.Combine(folder, $"{cell.Name}.{cell.Value}"));
        await Run(id);
        Assert.Equal(25, generated.Count);
        Assert.Contains("text-fusion", generated.Last()["loras"].ToString());
        Assert.Contains("0.8", generated.Last()["loraweights"].ToString());
    }

    [Theory]
    [InlineData("model", "krea2/shared-prefix-first.safetensors")]
    [InlineData("seed", "9")]
    [InlineData("variationseed", "9")]
    [InlineData("images", "2")]
    [InlineData("batchsize", "2")]
    [InlineData("imageformat", "JPG")]
    [InlineData("presets", "anything")]
    [InlineData("unknownsetting", "anything")]
    [InlineData("steps", "invalid")]
    public async Task InvalidOrLockedOverridesFailBeforeStarting(string key, string value)
    {
        string id = await Capture();
        JObject original = await Read(id);
        JObject response = await GridTweaksExtension.RunningGridRun(session, id, new JObject { ["overrides"] = new JObject { [key] = value } });
        Assert.NotNull(response["error"]);
        JObject current = await Read(id);
        Assert.False((bool)current["summary"]["running"]);
        Assert.True(JToken.DeepEquals(original["gallery"], current["gallery"]));
        Assert.Empty(generated);
    }

    [Fact]
    public async Task OverridePolicyLocksWholeLoraGroupAndRejectsMalformedRequests()
    {
        string id = await Capture("loras", "text-fusion");
        JObject data = await Read(id);
        string[] allowed = data["override_parameters"].Values<string>().ToArray();
        Assert.DoesNotContain("loras", allowed);
        Assert.DoesNotContain("loraweights", allowed);
        Assert.Contains("prompt", allowed);
        foreach (JToken overrides in new JToken[] { new JArray(), JValue.CreateNull(), new JObject { ["steps"] = new JObject() } })
        {
            JObject response = await GridTweaksExtension.RunningGridRun(session, id, new JObject { ["overrides"] = overrides });
            Assert.NotNull(response["error"]);
        }
        Assert.Empty(generated);
    }

    [Fact]
    public async Task OverridesRespectPresetsAndParameterPermissions()
    {
        session.User.SavePreset(new T2IPreset { Title = "Saved Style", ParamMap = new() { ["steps"] = "25", ["loras"] = "text-fusion" } });
        string id = await Capture(extra: new JObject { ["presets"] = new JArray("Saved Style") });
        JObject data = await Read(id);
        string[] allowed = data["override_parameters"].Values<string>().ToArray();
        Assert.DoesNotContain("steps", allowed);
        Assert.DoesNotContain("loraweights", allowed);
        JObject presetConflict = await GridTweaksExtension.RunningGridRun(session, id, new JObject { ["overrides"] = new JObject { ["steps"] = 30 } });
        Assert.NotNull(presetConflict["error"]);
        session.User.CalculatedRole.Data.PermissionFlags = [PermSaveGrids.ID, PermGenerateGrids.ID];
        JObject denied = await GridTweaksExtension.RunningGridRun(session, id, new JObject { ["overrides"] = new JObject { ["vae"] = "any" } });
        Assert.NotNull(denied["error"]);
        data = await Read(id);
        Assert.DoesNotContain("vae", data["override_parameters"].Values<string>());
        Assert.Empty(generated);
    }

    [Fact]
    public void SimilarNamesAndParameterOrderDoNotCollide()
    {
        Dictionary<string, string> first = new() { ["model"] = "folder/shared-long-prefix-first.safetensors", ["seed"] = "1" };
        Dictionary<string, string> reordered = new() { ["seed"] = "1", ["model"] = first["model"] };
        Dictionary<string, string> other = new() { ["model"] = "folder/shared-long-prefix-second.safetensors", ["seed"] = "1" };
        Assert.Equal(RunningGridDocument.Identity(first), RunningGridDocument.Identity(reordered));
        Assert.NotEqual(RunningGridDocument.Identity(first), RunningGridDocument.Identity(other));
    }

    public void Dispose()
    {
        models.Shutdown();
        loras.Shutdown();
        database.Dispose();
        Directory.Delete(temporary, true);
    }
}
