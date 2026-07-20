import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserCommand, webAppUrl } from "./browse.ts";

await describe("browse command", async () => {
  await it("opens the deployment root as the web application", () => {
    assert.equal(webAppUrl("https://memory.example"), "https://memory.example/");
    assert.equal(webAppUrl("https://memory.example/"), "https://memory.example/");
  });

  await it("uses platform-native URL launchers without a command shell", () => {
    assert.deepEqual(browserCommand("https://memory.example/", "darwin"), {
      executable: "open",
      args: ["https://memory.example/"]
    });
    assert.deepEqual(browserCommand("https://memory.example/", "linux"), {
      executable: "xdg-open",
      args: ["https://memory.example/"]
    });
    assert.deepEqual(browserCommand("https://memory.example/", "win32"), {
      executable: "rundll32",
      args: ["url.dll,FileProtocolHandler", "https://memory.example/"]
    });
  });
});
