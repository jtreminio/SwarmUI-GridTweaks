using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System.Security.Cryptography;

namespace GridTweaks;

public class RunningGridDocument
{
    public string Id = Guid.NewGuid().ToString("N");
    public string Title;
    /// <summary>Captured generation input, including reference images and locked seeds.</summary>
    public JObject BaseParams;
    public List<RunningGridAxis> Axes = [];
    /// <summary>Successfully saved cells, mapping extension-owned relative stems to media extensions.</summary>
    public Dictionary<string, string> Completed = [];
    public Dictionary<string, string> Presets = [];
    /// <summary>Output format is fixed for the lifetime of the gallery.</summary>
    public string Format;
    public bool PublishMetadata = true;
    /// <summary>Whether core should reorder generation to reduce model loads.</summary>
    public bool WeightOrder = true;
    public bool ContinueOnError;
    public bool TrackModelChanges = true;
    public string Status = "Ready";
    public string Error;
    /// <summary>Refresh similarity after subsequent generation runs once the user enables it.</summary>
    public bool SimilarityEnabled;
    public string SimilarityStatus = "Not analyzed";
    /// <summary>Fingerprint of run-only overrides per completed cell; old cells have unknown provenance.</summary>
    public Dictionary<string, string> CellSettings = [];
    /// <summary>Generation identities prevent old scores from being shown after replacement at the same path.</summary>
    public Dictionary<string, string> CellVersions = [];

    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    public static string Identity(Dictionary<string, string> values)
        => Hash(JsonConvert.SerializeObject(new SortedDictionary<string, string>(values, StringComparer.Ordinal)));

    public static string Segment(RunningGridValue value) => $"v{value.Id}_{value.Revision}";

    public static bool Includes(string stem, int axisIndex, RunningGridValue value)
    {
        string[] parts = stem.Split('/');
        return axisIndex >= 0 && axisIndex < parts.Length && parts[axisIndex].StartsWith($"v{value.Id}_", StringComparison.Ordinal);
    }

    public void DiscardLegacyRemovedValues()
    {
        for (int i = 0; i < Axes.Count; i++)
        {
            List<RunningGridValue> removed = Axes[i].Values.Where(value => value.Removed).ToList();
            if (removed.Count == 0)
            {
                continue;
            }
            foreach (string stem in Completed.Keys.Where(stem => removed.Any(value => Includes(stem, i, value))).ToArray())
            {
                Completed.Remove(stem);
                CellSettings.Remove(stem);
                CellVersions.Remove(stem);
            }
            Axes[i].Values.RemoveAll(value => value.Removed);
        }
    }

    public static int Merge(RunningGridAxis axis, IEnumerable<RunningGridValue> additions)
    {
        int added = 0;
        foreach (RunningGridValue value in additions)
        {
            if (axis.Values.Any(old => old.Id == value.Id))
            {
                continue;
            }
            axis.Values.Add(value);
            added++;
        }
        return added;
    }
}

public class RunningGridAxis
{
    /// <summary>Original parameter identifier used by the core parser.</summary>
    public string Mode;
    public string Title;
    public List<RunningGridValue> Values = [];
}

public class RunningGridValue
{
    /// <summary>Digest of the original normalized parameter map, before random seeds are locked.</summary>
    public string Id;
    public string Title;
    public Dictionary<string, string> Params = [];
    /// <summary>File revision digest; changing it prevents reuse of obsolete images.</summary>
    public string Revision = "initial";
    /// <summary>Last observed model-file signature; null when no local model is used.</summary>
    public string Fingerprint;
    public bool Skip;
    /// <summary>Legacy soft-deletion flag, read only to discard old entries during document loading.</summary>
    [JsonProperty(DefaultValueHandling = DefaultValueHandling.Ignore)]
    public bool Removed;
}
