using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Media;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.IO;
using System.Net;
using static SwarmUI.Builtin_GridGeneratorExtension.GridGenCore;
using static SwarmUI.Builtin_GridGeneratorExtension.GridGeneratorExtension;

namespace GridTweaks;

[API.APIClass("Grid Tweaks")]
public partial class GridTweaksExtension : Extension
{
    private const string StorageName = "running_grid_v1";
    private static readonly ConcurrentDictionary<string, GalleryGate> Gates = new();

    private class GalleryGate
    {
        public bool Running;
        public CancellationTokenSource SimilarityCancellation;
        public string SimilarityProgress;
        public Session.GenClaim Claim;
        /// <summary>Remembers a stop requested before the background worker creates its claim.</summary>
        public bool StopRequested;
        public string RunId = "";
        /// <summary>Completed image events for cursor-based delivery, retained until the next run.</summary>
        public List<JObject> Outputs = [];
        /// <summary>Only the latest preview for each currently generating cell.</summary>
        public Dictionary<string, JObject> Progress = [];
        /// <summary>Prevents delayed previews from replacing completed images.</summary>
        public HashSet<string> FinishedBatches = [];
    }

    public override void PopulateMetadata()
    {
        Version = "0.1.0";
        ExtensionAuthor = "jtreminio";
        Description = "Persistent core grids with incremental generation and removable axis values.";
        Tags = ["grids", "gallery", "comparison"];
    }

    public override void OnInit()
    {
        SimilarityExtensionFolder = Path.GetFullPath(FilePath);
        ScriptFiles.Add("Assets/running-grid.js");
        StyleSheetFiles.Add("Assets/running-grid.css");
        API.RegisterAPICall(RunningGridList, false, PermReadGrids);
        API.RegisterAPICall(RunningGridGet, false, PermReadGrids);
        API.RegisterAPICall(RunningGridCreate, true, PermSaveGrids);
        API.RegisterAPICall(RunningGridDelete, true, PermSaveGrids);
        API.RegisterAPICall(RunningGridAppend, true, PermSaveGrids);
        API.RegisterAPICall(RunningGridMembership, true, PermSaveGrids);
        API.RegisterAPICall(RunningGridMoveValue, true, PermSaveGrids);
        API.RegisterAPICall(RunningGridRun, true, PermGenerateGrids);
        API.RegisterAPICall(RunningGridCancel, true, PermGenerateGrids);
        API.RegisterAPICall(RunningGridSimilarity, true, PermSaveGrids);
    }

    private static GalleryGate Gate(Session session, string id)
    {
        if (!Guid.TryParseExact(id, "N", out _))
        {
            throw new SwarmUserErrorException("Invalid running grid ID.");
        }
        return Gates.GetOrAdd($"{session.User.UserID}/{id}", _ => new());
    }

    private static RunningGridDocument Load(Session session, string id)
    {
        string json = session.User.GetGenericData(StorageName, id);
        if (json is null)
        {
            throw new SwarmUserErrorException("Running grid not found.");
        }
        RunningGridDocument doc = JsonConvert.DeserializeObject<RunningGridDocument>(json);
        if (doc.Id != id)
        {
            throw new SwarmUserErrorException("Running grid ID does not match its saved document.");
        }
        doc.DiscardLegacyRemovedValues();
        return doc;
    }

    private static void Save(Session session, RunningGridDocument doc)
    {
        if (Program.NoPersist || !session.User.MayCreateSessions)
        {
            throw new SwarmUserErrorException("Running grids require persistent user storage.");
        }
        session.User.SaveGenericData(StorageName, doc.Id, JsonConvert.SerializeObject(doc));
    }

    /// <summary>Uses server-created names, including user isolation when core output paths are shared.</summary>
    private static string RelativeFolder(Session session, RunningGridDocument doc)
        => $"Grids/RunningGrid/{RunningGridDocument.Hash(session.User.UserID)}/{doc.Id}";

    private static string Folder(Session session, RunningGridDocument doc)
        => Path.Combine(session.User.OutputDirectory, RelativeFolder(session, doc));

    private static string UrlBase(Session session, RunningGridDocument doc)
        => $"{(Program.ServerSettings.Paths.AppendUserNameToOutputPath ? $"View/{Uri.EscapeDataString(session.User.UserID)}" : "Output")}/{RelativeFolder(session, doc)}";

    private static Task<JObject> Respond(Func<JObject> action)
    {
        try
        {
            return Task.FromResult(action());
        }
        catch (SwarmReadableErrorException ex)
        {
            return Task.FromResult(new JObject { ["error"] = ex.Message });
        }
    }

    private static void RequireIdle(GalleryGate gate)
    {
        if (gate.Running || gate.SimilarityCancellation is not null)
        {
            throw new SwarmUserErrorException("This gallery is running generation or similarity analysis. Stop it before changing its values.");
        }
    }

    private static JObject Summary(Session session, RunningGridDocument doc, GalleryGate gate)
    {
        long cells = 1;
        foreach (RunningGridAxis axis in doc.Axes)
        {
            cells *= axis.Values.Count(v => !v.Skip);
        }
        return new JObject
        {
            ["id"] = doc.Id, ["title"] = doc.Title, ["running"] = gate.Running,
            ["status"] = !gate.Running && doc.Status == "Running" ? "Interrupted; ready to resume" : doc.Status,
            ["error"] = doc.Error, ["completed"] = doc.Completed.Count, ["cells"] = cells,
            ["url"] = $"{UrlBase(session, doc)}/index.html",
            ["published"] = File.Exists(Path.Combine(Folder(session, doc), "index.html")),
            ["similarity_running"] = gate.SimilarityCancellation is not null,
            ["similarity_status"] = gate.SimilarityProgress ?? doc.SimilarityStatus,
            ["similarity_enabled"] = doc.SimilarityEnabled,
            ["similarity_ready"] = SimilarityReady
        };
    }

    [API.APIDescription("Lists the current user's running galleries.", "{galleries: [{id, title, status, running, completed, cells, url, published}]}")]
    public static Task<JObject> RunningGridList(Session session) => Respond(() =>
    {
        JArray galleries = [];
        foreach (string id in session.User.ListAllGenericData(StorageName))
        {
            GalleryGate gate = Gate(session, id);
            lock (gate)
            {
                galleries.Add(Summary(session, Load(session, id), gate));
            }
        }
        return new JObject { ["galleries"] = galleries };
    });

    private static void CheckDeleteDirectory(string root, string folder)
    {
        string relative = Path.GetRelativePath(root, folder);
        string current = root;
        foreach (string part in relative.Split(Path.DirectorySeparatorChar))
        {
            current = Path.Combine(current, part);
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
            {
                throw new SwarmUserErrorException("Cannot delete a gallery through a linked directory. Restore its original storage location first.");
            }
        }
    }

    [API.APIDescription("Permanently deletes an idle saved gallery, its generated files, and its private similarity results. Requires Save Grids and User Delete Image permissions.", "{success: true}")]
    public static Task<JObject> RunningGridDelete(Session session,
        [API.APIParameter("Server-created gallery ID returned by RunningGridList. Only the current user's galleries can be deleted.")] string id) => Respond(() =>
    {
        if (!session.User.HasPermission(PermSaveGrids) || !session.User.HasPermission(Permissions.UserDeleteImage))
        {
            throw new SwarmUserErrorException("Deleting a gallery requires Save Grids and User Delete Image permissions.");
        }
        if (Program.NoPersist || !session.User.MayCreateSessions)
        {
            throw new SwarmUserErrorException("Deleting a saved gallery requires persistent user storage.");
        }
        GalleryGate gate = Gate(session, id);
        lock (gate)
        {
            RequireIdle(gate);
            RunningGridDocument doc = Load(session, id);
            string folder = Folder(session, doc);
            string cache = SimilarityFolder(session, doc);
            try
            {
                CheckDeleteDirectory(session.User.OutputDirectory, folder);
                CheckDeleteDirectory(SimilarityExtensionFolder, cache);
                // Keep the saved entry if cleanup fails so the user can retry deletion.
                if (Directory.Exists(cache))
                {
                    Directory.Delete(cache, true);
                }
                if (Directory.Exists(folder))
                {
                    Directory.Delete(folder, true);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Logs.Error($"Running Grid {doc.Id} could not delete files: {ex.Message}");
                throw new SwarmUserErrorException("Some gallery files could not be deleted. The saved entry was kept; check the server log and retry.");
            }
            if (!session.User.DeleteGenericData(StorageName, id))
            {
                throw new SwarmUserErrorException("Gallery files were deleted, but its saved entry could not be removed. Refresh the list and retry.");
            }
            gate.RunId = "";
            gate.Outputs.Clear();
            gate.Progress.Clear();
            gate.FinishedBatches.Clear();
            // Retain the gate: callers already waiting on this lock must not get a different lock.
            return new JObject { ["success"] = true };
        }
    });

    [API.APIDescription("Reads a running gallery, allowed run override parameter IDs, and optional image events for the generation batch column.", "{gallery: {...}, override_parameters: [string], summary: {...}, live?: {run_id, outputs, progress, next_output, has_more}}")]
    public static Task<JObject> RunningGridGet(Session session,
        [API.APIParameter("Server-created gallery ID.")] string id,
        [API.APIParameter("If true, omit the saved gallery definition.")] bool summaryOnly = false,
        [API.APIParameter("Include completed image events and current generation previews.")] bool includeOutputs = false,
        [API.APIParameter("Run ID from the previous live response; a different ID resets the output cursor.")] string runId = "",
        [API.APIParameter("Number of completed image events already received for runId.")] int afterOutput = 0) => Respond(() =>
    {
        GalleryGate gate = Gate(session, id);
        lock (gate)
        {
            RunningGridDocument doc = Load(session, id);
            JObject result = new() { ["summary"] = Summary(session, doc, gate) };
            if (!summaryOnly)
            {
                result["gallery"] = JObject.FromObject(doc);
                result["override_parameters"] = new JArray(RunOverrideTypes(session, doc).Keys);
            }
            if (includeOutputs)
            {
                int start = runId == gate.RunId ? Math.Clamp(afterOutput, 0, gate.Outputs.Count) : 0;
                int end = Math.Min(start + 128, gate.Outputs.Count);
                result["live"] = new JObject
                {
                    ["run_id"] = gate.RunId,
                    ["outputs"] = new JArray(gate.Outputs.Skip(start).Take(end - start).Select(o => o.DeepClone())),
                    ["progress"] = new JArray(gate.Progress.Values.Select(p => p.DeepClone())),
                    ["next_output"] = end,
                    ["has_more"] = end < gate.Outputs.Count
                };
            }
            return result;
        }
    });

    /// <summary>Parses values through core, then replaces its order-dependent filenames with stable identities.</summary>
    private static RunningGridAxis ParseAxis(Session session, T2IParamInput input, string mode, string values)
    {
        if (string.IsNullOrWhiteSpace(mode) || string.IsNullOrWhiteSpace(values))
        {
            throw new SwarmUserErrorException("Each axis needs a parameter and at least one value.");
        }
        Axis axis = new();
        axis.BuildFromListStr(mode, new Grid { InitialParams = input }, values);
        if (axis.Mode.Permission is not null && !session.User.HasPermission(axis.Mode.Permission))
        {
            throw new SwarmUserErrorException($"You do not have permission to use {axis.Mode.Name}.");
        }
        RunningGridAxis saved = new() { Mode = mode, Title = axis.Title };
        Dictionary<string, int> occurrences = [];
        foreach (AxisValue value in axis.Values)
        {
            string identity = RunningGridDocument.Identity(value.Params);
            int occurrence = occurrences.GetValueOrDefault(identity);
            occurrences[identity] = occurrence + 1;
            RunningGridValue item = new()
            {
                Id = RunningGridDocument.Hash($"{identity}:{occurrence}"), Title = value.Title,
                Params = new(value.Params), Skip = value.Skip
            };
            foreach (string key in item.Params.Keys.ToArray())
            {
                if (T2IParamTypes.GetType(key, input)?.ViewType == ParamViewType.SEED && item.Params[key] == "-1")
                {
                    item.Params[key] = Random.Shared.Next().ToString();
                    item.Title = $"{item.Params[key]} (locked from -1)";
                }
            }
            RunningGridDocument.Merge(saved, [item]);
        }
        if (saved.Values.Count == 0)
        {
            throw new SwarmUserErrorException("The axis contains no values.");
        }
        return saved;
    }

    private static void ValidateSize(RunningGridDocument doc)
    {
        long cells = 1;
        foreach (RunningGridAxis axis in doc.Axes)
        {
            cells *= axis.Values.Count;
            if (cells > 100000)
            {
                throw new SwarmUserErrorException("A running grid supports at most 100,000 combinations. Split this comparison into multiple galleries.");
            }
        }
    }

    private static void CheckPresets(Session session, RunningGridDocument doc)
    {
        List<string> names = doc.BaseParams["presets"] is JArray presets ? presets.Values<string>().ToList() : [];
        foreach (RunningGridValue value in doc.Axes.SelectMany(a => a.Values).Where(v => !v.Skip))
        {
            if (value.Params.TryGetValue(PresetsParameter.Type.ID, out string list))
            {
                names.AddRange(list.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries));
            }
        }
        // Prompt presets also affect the generated input, even when they are not a grid axis.
        IEnumerable<string> texts = doc.BaseParams.Properties().Where(p => p.Name.EndsWith("prompt")).Select(p => p.Value.ToString())
            .Concat(doc.Axes.SelectMany(a => a.Values).SelectMany(v => v.Params.Values));
        foreach (string text in texts)
        {
            foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(text, @"<preset:([^>]+)>"))
            {
                names.Add(match.Groups[1].Value);
            }
        }
        foreach (string name in names.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            T2IPreset preset = session.User.GetPreset(name);
            if (preset is null)
            {
                throw new SwarmUserErrorException($"Saved grid preset '{name}' is unavailable.");
            }
            if (preset.ParamMap.Any(p => p.Key.EndsWith("seed", StringComparison.OrdinalIgnoreCase) && p.Value == "-1"))
            {
                throw new SwarmUserErrorException($"Preset '{name}' contains a random seed. Set an explicit seed in that preset before capturing a running grid.");
            }
            string key = name.ToLowerFast();
            string signature = RunningGridDocument.Identity(preset.ParamMap);
            if (doc.Presets.TryGetValue(key, out string old) && old != signature)
            {
                throw new SwarmUserErrorException($"Preset '{name}' changed since this gallery was captured. Restore it or create a new gallery.");
            }
            doc.Presets[key] = signature;
        }
    }

    /// <summary>Loads captured settings; model axes supply their own models even if the old base model was uninstalled.</summary>
    private static T2IParamInput LoadInput(Session session, RunningGridDocument doc, JObject overrides = null)
    {
        JObject raw = (JObject)doc.BaseParams.DeepClone();
        if (overrides is not null)
        {
            foreach (JProperty parameter in overrides.Properties())
            {
                if (parameter.Value.Type == JTokenType.Null)
                {
                    raw.Remove(parameter.Name);
                }
                else
                {
                    raw[parameter.Name] = parameter.Value.DeepClone();
                }
            }
        }
        if (doc.Axes.Any(a => a.Mode == "model"))
        {
            raw.Remove("model");
        }
        T2IParamInput input = T2IAPI.RequestToParams(session, raw, false);
        foreach (JProperty parameter in raw.Properties())
        {
            if (parameter.Name is not ("presets" or "extra_metadata" or "session_id")
                && !T2IParamTypes.TryGetType(parameter.Name, out _, input))
            {
                throw new SwarmUserErrorException($"Saved parameter '{parameter.Name}' is unavailable. Enable its extension before resuming this gallery.");
            }
        }
        input.Remove(T2IParamTypes.BatchSize);
        input.Remove(T2IParamTypes.Images);
        input.Remove(T2IParamTypes.OutputIntermediateImages);
        return input;
    }

    private static Dictionary<string, T2IParamType> RunOverrideTypes(Session session, RunningGridDocument doc)
    {
        HashSet<string> locked = new(doc.Axes.SelectMany(axis => axis.Values.SelectMany(value => value.Params.Keys).Append(axis.Mode)));
        locked.UnionWith(["presets", "images", "batchsize", "outputintermediateimages", "imageformat", "donotsave"]);
        foreach (string name in doc.Presets.Keys)
        {
            T2IPreset preset = session.User.GetPreset(name);
            if (preset is not null)
            {
                locked.UnionWith(preset.ParamMap.Keys.Select(T2IParamTypes.CleanTypeName));
            }
        }
        if (locked.Contains(PromptReplaceParameter.Type.ID) || locked.Contains(PromptAddParameter.Type.ID))
        {
            locked.Add("prompt");
        }
        string[] loraKeys = ["loras", "loraweights", "loratencweights", "lorasectionconfinement"];
        if (loraKeys.Any(locked.Contains))
        {
            locked.UnionWith(loraKeys);
        }
        return T2IParamTypes.Types.Values.Where(type => !locked.Contains(type.ID) && type.ViewType != ParamViewType.SEED
            && !type.Name.StartsWith("[Grid Gen]", StringComparison.Ordinal)
            && (type.Permission is null || session.User.HasPermission(type.Permission)))
            .ToDictionary(type => type.ID);
    }

    private static T2IParamInput RunInput(Session session, RunningGridDocument doc, JObject raw)
    {
        JToken supplied = raw?["overrides"];
        if (supplied is null)
        {
            return LoadInput(session, doc);
        }
        if (supplied is not JObject overrides)
        {
            throw new SwarmUserErrorException("Run overrides must be an object of parameter IDs and values.");
        }
        Dictionary<string, T2IParamType> allowed = RunOverrideTypes(session, doc);
        foreach (JProperty parameter in overrides.Properties())
        {
            if (!allowed.ContainsKey(parameter.Name))
            {
                throw new SwarmUserErrorException($"Parameter '{parameter.Name}' cannot be overridden for this gallery. Axes, seeds, preset settings and output controls stay locked.");
            }
            if (parameter.Value is JObject || (parameter.Value is JArray array && array.Any(value => value is JContainer)))
            {
                throw new SwarmUserErrorException($"Invalid override value for '{parameter.Name}'. Use a parameter value, list, or null to disable it.");
            }
        }
        // Input parsing performs normal parameter validation, model access checks and permission checks.
        return LoadInput(session, doc, overrides);
    }

    [API.APIDescription("Captures the current core grid settings as a new persistent gallery. Does not generate images.", "{id: string}")]
    public static Task<JObject> RunningGridCreate(Session session,
        [API.APIParameter("Gallery display name, at most 200 characters.")] string title,
        [API.APIParameter("Request containing baseParams, gridAxes [{mode, vals}], and optional core output options.")] JObject raw) => Respond(() =>
    {
        if (string.IsNullOrWhiteSpace(title) || title.Length > 200 || raw["baseParams"] is not JObject supplied || raw["gridAxes"] is not JArray axes || axes.Count == 0)
        {
            throw new SwarmUserErrorException("Provide a gallery name, generation settings, and at least one Grid Generator axis.");
        }
        if (axes.Count > 8)
        {
            throw new SwarmUserErrorException("A running grid supports up to eight axes.");
        }
        RunningGridDocument doc = new()
        {
            Title = title.Trim(), BaseParams = (JObject)supplied.DeepClone(),
            Format = ImageFile.ImageFormatToExtension(session.User.Settings.FileFormat.ImageFormat),
            PublishMetadata = (bool?)raw["publishMetadata"] ?? true,
            WeightOrder = (bool?)raw["weightOrder"] ?? true,
            ContinueOnError = (bool?)raw["continueOnError"] ?? false,
            TrackModelChanges = (bool?)raw["trackModelChanges"] ?? true
        };
        string imageFormat = (string)doc.BaseParams["imageformat"] ?? session.User.Settings.FileFormat.ImageFormat;
        doc.BaseParams["imageformat"] = imageFormat;
        doc.Format = ImageFile.ImageFormatToExtension(imageFormat);
        JObject initial = (JObject)doc.BaseParams.DeepClone();
        if (axes.Any(a => (string)a["mode"] == "model"))
        {
            initial.Remove("model");
        }
        T2IParamInput input = T2IAPI.RequestToParams(session, initial, false);
        input.LockSeeds();
        doc.BaseParams["seed"] = input.Get(T2IParamTypes.Seed).ToString();
        if (input.TryGet(T2IParamTypes.VariationSeed, out long variationSeed))
        {
            doc.BaseParams["variationseed"] = variationSeed.ToString();
        }
        foreach (JProperty parameter in doc.BaseParams.Properties().ToArray())
        {
            if (T2IParamTypes.GetType(parameter.Name, input)?.ViewType == ParamViewType.SEED && parameter.Value.ToString() == "-1")
            {
                parameter.Value = Random.Shared.Next().ToString();
            }
        }
        foreach (JToken axis in axes)
        {
            doc.Axes.Add(ParseAxis(session, input, (string)axis["mode"], (string)axis["vals"]));
        }
        ValidateSize(doc);
        CheckPresets(session, doc);
        Save(session, doc);
        return new JObject { ["id"] = doc.Id };
    });

    [API.APIDescription("Adds new values to the first axis using core grid syntax. Previously deleted values can be added again. All other axes and base settings remain locked.", "{added: number}")]
    public static Task<JObject> RunningGridAppend(Session session,
        [API.APIParameter("Server-created gallery ID.")] string id,
        [API.APIParameter("Core grid values, including comma or double-pipe lists and numeric ranges.")] string values) => Respond(() =>
    {
        GalleryGate gate = Gate(session, id);
        lock (gate)
        {
            RequireIdle(gate);
            RunningGridDocument doc = Load(session, id);
            RunningGridAxis axis = doc.Axes[0];
            RunningGridAxis parsed = ParseAxis(session, LoadInput(session, doc), axis.Mode, values);
            int added = RunningGridDocument.Merge(axis, parsed.Values);
            ValidateSize(doc);
            CheckPresets(session, doc);
            Save(session, doc);
            Publish(session, doc, BuildGrid(session, doc));
            return new JObject { ["added"] = added };
        }
    });

    [API.APIDescription("Permanently removes first-axis values and their generated files from this gallery. Model files are never deleted. Values can be added again normally.", "{success: true}")]
    public static Task<JObject> RunningGridMembership(Session session,
        [API.APIParameter("Server-created gallery ID.")] string id,
        [API.APIParameter("Stable IDs returned by RunningGridGet.")] string[] valueIds,
        [API.APIParameter("Must be true. Retained for compatibility; restoring deleted entries is no longer supported.")] bool removed = true) => Respond(() =>
    {
        GalleryGate gate = Gate(session, id);
        lock (gate)
        {
            RequireIdle(gate);
            RunningGridDocument doc = Load(session, id);
            if (!removed)
            {
                throw new SwarmUserErrorException("Deleted columns cannot be restored. Add their values again to create new columns.");
            }
            RunningGridAxis axis = doc.Axes[0];
            List<RunningGridValue> selected = axis.Values.Where(v => valueIds.Contains(v.Id)).ToList();
            if (!session.User.HasPermission(Permissions.UserDeleteImage))
            {
                throw new SwarmUserErrorException("Deleting gallery results requires the User Delete Image permission.");
            }
            if (selected.Count != valueIds.Distinct().Count() || selected.Count == 0)
            {
                throw new SwarmUserErrorException("Select valid axis values.");
            }
            axis.Values.RemoveAll(value => valueIds.Contains(value.Id));
            // A fresh browser must not replay image events for files removed from this gallery.
            gate.RunId = "";
            gate.Outputs.Clear();
            gate.Progress.Clear();
            gate.FinishedBatches.Clear();
            foreach (string stem in doc.Completed.Keys.Where(p => selected.Any(v => RunningGridDocument.Includes(p, 0, v))).ToArray())
            {
                doc.Completed.Remove(stem);
                doc.CellSettings.Remove(stem);
                doc.CellVersions.Remove(stem);
            }
            Save(session, doc);
            Publish(session, doc, BuildGrid(session, doc));
            string folder = Folder(session, doc);
            foreach (string path in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
            {
                string relative = Path.GetRelativePath(folder, path).Replace('\\', '/');
                if (selected.Any(v => RunningGridDocument.Includes(relative, 0, v)))
                {
                    File.Delete(path);
                }
            }
            return new JObject { ["success"] = true };
        }
    });

    [API.APIDescription("Places a first-axis column before or after another visible column and republishes the gallery without generating or moving images.", "{success: true, moved: boolean}")]
    public static Task<JObject> RunningGridMoveValue(Session session,
        [API.APIParameter("Server-created gallery ID.")] string id,
        [API.APIParameter("Stable ID of a first-axis value returned by RunningGridGet. Removed values cannot be moved.")] string valueId,
        [API.APIParameter("Stable ID of the visible first-axis column to drop beside.")] string targetId,
        [API.APIParameter("True places the column after the target; false places it before the target.")] bool after = false) => Respond(() =>
    {
        GalleryGate gate = Gate(session, id);
        lock (gate)
        {
            RequireIdle(gate);
            RunningGridDocument doc = Load(session, id);
            List<RunningGridValue> values = doc.Axes[0].Values;
            int index = values.FindIndex(v => v.Id == valueId);
            int target = values.FindIndex(v => v.Id == targetId);
            if (index < 0 || target < 0)
            {
                throw new SwarmUserErrorException("Choose columns currently in this gallery.");
            }
            int destination = target + (after ? 1 : 0) - (index < target ? 1 : 0);
            if (index == target || index == destination)
            {
                return new JObject { ["success"] = true, ["moved"] = false };
            }
            RunningGridValue moved = values[index];
            values.RemoveAt(index);
            values.Insert(destination, moved);
            Grid grid = BuildGrid(session, doc);
            Save(session, doc);
            Publish(session, doc, grid);
            return new JObject { ["success"] = true, ["moved"] = true };
        }
    });

    /// <summary>Detects local model changes using size and modification time without hashing multi-gigabyte files.</summary>
    private static string Fingerprint(Session session, RunningGridValue value, T2IParamInput input)
    {
        List<string> signatures = [];
        foreach ((string key, string text) in value.Params.OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            T2IParamType type = T2IParamTypes.GetType(key, input);
            if (type is null || (type.Type != T2IParamDataType.MODEL && type.Subtype != "LoRA"))
            {
                continue;
            }
            if (!Program.T2IModelSets.TryGetValue(type.Subtype ?? "Stable-Diffusion", out T2IModelHandler handler))
            {
                continue;
            }
            foreach (string name in text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                T2IModel model = handler.GetModel(name);
                if (model?.RawFilePath is null || !session.User.IsAllowedModel(model.Name) || !File.Exists(model.RawFilePath))
                {
                    // Keep already-rendered, unavailable models visible. Missing new cells fail validation before generation.
                    return value.Fingerprint;
                }
                FileInfo file = new(model.RawFilePath);
                signatures.Add($"{key}:{model.Name}:{file.Length}:{file.LastWriteTimeUtc.Ticks}");
            }
        }
        return signatures.Count == 0 ? null : RunningGridDocument.Hash(string.Join("\n", signatures));
    }

    private static Grid BuildGrid(Session session, RunningGridDocument doc, SwarmUIGridData data = null, T2IParamInput runInput = null)
    {
        T2IParamInput input = runInput ?? LoadInput(session, doc);
        Grid grid = new()
        {
            Title = doc.Title, Description = "Persistent comparison maintained by Running Grid.", Author = session.User.UserID,
            Format = doc.Format, InitialParams = input.Clone(), LocalData = data,
            PublishMetadata = doc.PublishMetadata, OutputType = Grid.OutputyTypeEnum.WEB_PAGE,
            MinWidth = input.GetImageWidth(), MinHeight = input.GetImageHeight(),
            DefaultX = "axis0", DefaultY = $"axis{doc.Axes.Count - 1}",
            MustCancel = () => data?.Claim.ShouldCancel == true || Program.GlobalProgramCancel.IsCancellationRequested
        };
        for (int i = 0; i < doc.Axes.Count; i++)
        {
            RunningGridAxis saved = doc.Axes[i];
            Axis axis = new()
            {
                ID = $"axis{i}", RawID = saved.Mode, ModeName = saved.Mode,
                Mode = T2IParamTypes.GetType(saved.Mode, input), Title = saved.Title, Index = i
            };
            if (axis.Mode is null)
            {
                throw new SwarmUserErrorException($"Parameter '{saved.Mode}' is unavailable. Enable its extension before using this gallery.");
            }
            foreach (RunningGridValue value in saved.Values)
            {
                AxisValue item = new(grid, axis, RunningGridDocument.Segment(value), $"{saved.Mode}=", value.Title)
                {
                    Params = new(value.Params), Skip = value.Skip
                };
                axis.Values.Add(item);
            }
            grid.Axes.Add(axis);
        }
        grid.Runner = new GridRunner
        {
            Grid = grid, Params = input, BasePath = Folder(session, doc), URLBase = UrlBase(session, doc),
            WeightOrder = doc.WeightOrder, FastSkip = false, DoOverwrite = true
        };
        return grid;
    }

    /// <summary>Uses core's HTML viewer, escaping labels once in every HTML context before substituting them.</summary>
    private static void Publish(Session session, RunningGridDocument doc, Grid grid)
    {
        string folder = Folder(session, doc);
        Directory.CreateDirectory(folder);
        foreach (string asset in EXTRA_ASSETS.Union(["bootstrap.min.css", "bootstrap.bundle.min.js", "proc.js", "jquery.min.js", "jsgif.js", "styles.css", "styles-user.css", "placeholder.png"]))
        {
            File.Copy(Path.Combine(ASSETS_DIR, asset), Path.Combine(folder, asset), true);
        }
        Dictionary<string, string> labels = [];
        string tokenPrefix = $"runninggrid{Guid.NewGuid():N}";
        string label(string text)
        {
            string token = $"{tokenPrefix}_{labels.Count}_end";
            labels[token] = WebUtility.HtmlEncode(text ?? "");
            return token;
        }
        string title = grid.Title, author = grid.Author;
        List<(Axis axis, string title)> axes = grid.Axes.Select(a => (a, a.Title)).ToList();
        List<(AxisValue value, string title)> values = grid.Axes.SelectMany(a => a.Values).Select(v => (v, v.Title)).ToList();
        string html;
        try
        {
            grid.Title = label(grid.Title);
            grid.Author = label(grid.Author);
            foreach ((Axis axis, string text) in axes)
            {
                axis.Title = label(text);
            }
            foreach ((AxisValue value, string text) in values)
            {
                value.Title = label(text);
            }
            html = grid.Runner.BuildHtml("");
        }
        finally
        {
            grid.Title = title;
            grid.Author = author;
            foreach ((Axis axis, string text) in axes)
            {
                axis.Title = text;
            }
            foreach ((AxisValue value, string text) in values)
            {
                value.Title = text;
            }
        }
        foreach ((string token, string text) in labels)
        {
            html = html.Replace(token, text);
        }
        if (grid.Axes.Any(a => a.Values.Count == 0))
        {
            html = $"<!doctype html><html><head><meta charset=\"utf-8\"><title>{WebUtility.HtmlEncode(doc.Title)}</title></head><body><h1>{WebUtility.HtmlEncode(doc.Title)}</h1><p>This gallery has an empty axis. Add values in Running Grids.</p></body></html>";
        }
        WriteAtomic(Path.Combine(folder, "data.js"), "rawData = " + grid.Runner.BuildJson(grid.InitialParams, !Gates[$"{session.User.UserID}/{doc.Id}"].Running));
        html = PublishSimilarity(session, doc, html);
        WriteAtomic(Path.Combine(folder, "index.html"), html);
        if (!File.Exists(Path.Combine(folder, "last.js")))
        {
            WriteAtomic(Path.Combine(folder, "last.js"), "window.lastUpdated = [];");
        }
    }

    private static void WriteAtomic(string path, string content)
    {
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, content);
        File.Move(temporary, path, true);
    }

    [API.APIDescription("Starts a background run using saved settings and optional explicit overrides for this run only. Existing completed cells are kept. Poll RunningGridGet for progress.", "{started: true, run_id: string}")]
    public static Task<JObject> RunningGridRun(Session session,
        [API.APIParameter("Server-created gallery ID.")] string id,
        [API.APIParameter("Optional overrides object keyed by allowed IDs from RunningGridGet. Null values disable parameters. Overrides affect only generated cells and never update saved settings.")] JObject raw = null) => Respond(() =>
    {
        if (!session.User.HasPermission(PermSaveGrids))
        {
            throw new SwarmUserErrorException("Saving grids permission is required to update a running gallery.");
        }
        GalleryGate gate = Gate(session, id);
        lock (gate)
        {
            RequireIdle(gate);
            RunningGridDocument doc = Load(session, id);
            CheckPresets(session, doc);
            ValidateSize(doc);
            if (doc.Axes.Any(a => a.Values.All(v => v.Skip)))
            {
                throw new SwarmUserErrorException("Every axis needs at least one active value.");
            }
            T2IParamInput runInput = RunInput(session, doc, raw);
            gate.Running = true;
            gate.StopRequested = false;
            gate.RunId = Guid.NewGuid().ToString("N");
            gate.Outputs.Clear();
            gate.Progress.Clear();
            gate.FinishedBatches.Clear();
            doc.Status = "Running";
            doc.Error = null;
            try
            {
                Save(session, doc);
                _ = Task.Run(() => Execute(session, doc, gate, runInput));
            }
            catch
            {
                gate.Running = false;
                throw;
            }
            return new JObject { ["started"] = true, ["run_id"] = gate.RunId };
        }
    });

    [API.APIDescription("Interrupts only the selected running gallery. Completed cells remain resumable.", "{success: true}")]
    public static Task<JObject> RunningGridCancel(Session session,
        [API.APIParameter("Server-created gallery ID.")] string id) => Respond(() =>
    {
        GalleryGate gate = Gate(session, id);
        lock (gate)
        {
            Load(session, id);
            gate.StopRequested = true;
            gate.Claim?.LocalClaimInterrupt.Cancel();
            gate.SimilarityCancellation?.Cancel();
            return new JObject { ["success"] = true };
        }
    });

    private static async Task Execute(Session session, RunningGridDocument doc, GalleryGate gate, T2IParamInput input)
    {
        using Session.GenClaim claim = session.Claim();
        SwarmUIGridData data = new()
        {
            Session = session, Claim = claim,
            ContinueOnError = doc.ContinueOnError, ShowOutputs = true
        };
        Grid grid = null;
        Task producer = Task.CompletedTask;
        try
        {
            string settingsIdentity = SettingsIdentity(input, doc);
            data.MaxSimul = session.User.CalcMaxT2ISimultaneous;
            lock (gate)
            {
                gate.Claim = claim;
                if (gate.StopRequested)
                {
                    claim.LocalClaimInterrupt.Cancel();
                }
            }
            foreach (RunningGridValue value in doc.Axes[0].Values.Where(v => !v.Skip))
            {
                string fingerprint = Fingerprint(session, value, input);
                if (doc.TrackModelChanges && fingerprint is not null && value.Fingerprint is not null && fingerprint != value.Fingerprint)
                {
                    value.Revision = Guid.NewGuid().ToString("N");
                }
                value.Fingerprint = fingerprint;
            }
            grid = BuildGrid(session, doc, data, input);
            GridRunner runner = grid.Runner;
            // Prepare ourselves so a committed output, not a merely existing or partial file, determines completion.
            // Planning must cover the complete gallery even when a stop arrives midway through it.
            // Otherwise pruning obsolete paths would discard completion records for unvisited cells.
            Func<bool> shouldCancel = grid.MustCancel;
            grid.MustCancel = () => false;
            try
            {
                runner.Sets = runner.BuildValueSetList([.. grid.Axes]);
            }
            finally
            {
                grid.MustCancel = shouldCancel;
            }
            HashSet<string> currentPaths = [];
            foreach (SingleGridCall set in runner.Sets)
            {
                set.BuildBasePaths();
                currentPaths.Add(set.BaseFilepath);
                bool complete = doc.Completed.TryGetValue(set.BaseFilepath, out string ext)
                    && File.Exists(Path.Combine(runner.BasePath, $"{set.BaseFilepath}.{ext}"));
                if (!complete)
                {
                    doc.Completed.Remove(set.BaseFilepath);
                    doc.CellSettings.Remove(set.BaseFilepath);
                    doc.CellVersions.Remove(set.BaseFilepath);
                }
                set.Skip |= complete;
                if (set.Skip)
                {
                    runner.TotalSkip++;
                    continue;
                }
                foreach (AxisValue value in set.Values)
                {
                    foreach ((string key, string text) in value.Params)
                    {
                        // Core's Set does not check permissions; validate each pending override first.
                        T2IParamTypes.ApplyParameter(key, text, input.Clone());
                    }
                }
                set.FlattenParams(grid);
                runner.TotalRun++;
            }
            foreach (string obsolete in doc.Completed.Keys.Where(p => !currentPaths.Contains(p)).ToArray())
            {
                doc.Completed.Remove(obsolete);
                doc.CellSettings.Remove(obsolete);
                doc.CellVersions.Remove(obsolete);
            }
            claim.Extend(runner.TotalRun);
            lock (gate)
            {
                Save(session, doc);
                Publish(session, doc, grid);
            }
            producer = Task.Run(() => runner.Run(false));
            Dictionary<string, string> expected = runner.Sets.Where(s => !s.Skip).ToDictionary(s => $"/{runner.URLBase}/{s.BaseFilepath}", s => s.BaseFilepath);
            while (!producer.IsCompleted || data.GetActive().Length > 0 || !data.Generated.IsEmpty)
            {
                await data.Signal.WaitAsync(TimeSpan.FromMilliseconds(250));
                while (data.Generated.TryDequeue(out JObject output))
                {
                    if (output["gen_progress"] is JObject progress)
                    {
                        lock (gate)
                        {
                            string batchIndex = (string)progress["batch_index"];
                            if (batchIndex is not null && !gate.FinishedBatches.Contains(batchIndex))
                            {
                                gate.Progress[batchIndex] = (JObject)output.DeepClone();
                            }
                        }
                    }
                    string image = (string)output["image"];
                    if (image is null)
                    {
                        continue;
                    }
                    int dot = image.LastIndexOf('.');
                    if (dot < 0 || !expected.TryGetValue(image[..dot], out string stem))
                    {
                        continue;
                    }
                    lock (gate)
                    {
                        doc.Completed[stem] = image[(dot + 1)..];
                        doc.CellSettings[stem] = settingsIdentity;
                        doc.CellVersions[stem] = Guid.NewGuid().ToString("N");
                        Save(session, doc);
                        string batchIndex = (string)output["batch_index"] ?? stem;
                        gate.Progress.Remove(batchIndex);
                        gate.FinishedBatches.Add(batchIndex);
                        gate.Outputs.Add((JObject)output.DeepClone());
                        // Keep URLs for every completed cell, but bound the metadata held by long-running galleries.
                        // Core can read older metadata from the image when it is opened in the batch column.
                        if (gate.Outputs.Count > 256)
                        {
                            gate.Outputs[gate.Outputs.Count - 257].Remove("metadata");
                        }
                    }
                }
            }
            await producer;
            await Task.WhenAll(data.Rendering);
            if (data.ErrorOut is not null)
            {
                throw new SwarmUserErrorException((string)data.ErrorOut["error"]);
            }
            doc.Status = claim.ShouldCancel ? "Stopped; ready to resume" : "Complete";
        }
        catch (Exception ex)
        {
            claim.LocalClaimInterrupt.Cancel();
            // Never release the gallery gate while old generation tasks may still write its images.
            try
            {
                await producer;
            }
            catch { }
            try
            {
                await Task.WhenAll(data.Rendering);
            }
            catch { }
            doc.Status = "Error; ready to resume";
            doc.Error = (string)ExToError(ex)["error"];
            Logs.Error($"Running Grid {doc.Id}: {ex.Message}");
        }
        finally
        {
            lock (gate)
            {
                gate.Claim = null;
                gate.Running = false;
                gate.Progress.Clear();
                try
                {
                    Save(session, doc);
                    if (grid is not null)
                    {
                        Publish(session, doc, grid);
                    }
                }
                catch (Exception ex)
                {
                    Logs.Error($"Running Grid {doc.Id} could not save final state: {ex.Message}");
                }
                if (doc.SimilarityEnabled && !gate.StopRequested && doc.Status == "Complete")
                {
                    StartSimilarity(session, doc, gate, false);
                }
            }
        }
    }
}
