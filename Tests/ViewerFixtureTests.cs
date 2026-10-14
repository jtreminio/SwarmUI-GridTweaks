using Newtonsoft.Json.Linq;
using Xunit;

namespace GridTweaks.Tests;

public partial class RunningGridTests
{
    [Fact]
    [Trait("Category", "BrowserFixture")]
    public async Task PublishesThreeAxisViewerFixture()
    {
        JObject created = await GridTweaksExtension.RunningGridCreate(session, "Three-axis comparison", new JObject
        {
            ["baseParams"] = new JObject { ["prompt"] = "a fixed prompt", ["seed"] = 1, ["width"] = 512, ["height"] = 512, ["steps"] = 20 },
            ["gridAxes"] = new JArray
            {
                new JObject { ["mode"] = "model", ["vals"] = string.Join(",", models.Models.Keys.Order()) },
                new JObject { ["mode"] = "seed", ["vals"] = "1,2" },
                new JObject { ["mode"] = "steps", ["vals"] = "10,20" }
            }
        });
        Assert.Null(created["error"]);
        JObject state = await Run((string)created["id"]);
        Assert.Equal(8, generated.Count);
        string folder = Path.GetDirectoryName(Path.Combine(session.User.OutputDirectory, ((string)state["summary"]["url"])["Output/".Length..]));
        string fixture = Path.Combine(AppContext.BaseDirectory, "SimilarityViewer", "ThreeAxes");
        Directory.CreateDirectory(fixture);
        foreach (string path in Directory.GetFiles(folder))
        {
            File.Copy(path, Path.Combine(fixture, Path.GetFileName(path)), true);
        }
    }
}
